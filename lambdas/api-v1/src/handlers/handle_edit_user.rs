use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
    http::StatusCode,
};
use serde::Deserialize;
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, CryptographicOps, http_error, UserSession};
use crate::handlers::common;


#[derive(Debug, Deserialize)]
pub struct UserEditBody {
    pub password: String,
    pub new_password: Option<String>,
    pub new_email: Option<String>,
}

#[axum::debug_handler]
pub async fn handle_edit_user(
    State(state): State<AppState>,
    user_session: UserSession,
    cryptographic_ops: CryptographicOps,
    Json(body): Json<UserEditBody>,
) -> Result<StatusCode, HandlerErrOutput> {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, "user edit attempt");

    let user = common::fetch_user_by_id(&state.dynamo_client, &state.users_table_name, &user_id).await?;

    // Verify current password
    let password_valid = match (cryptographic_ops.verify_password)(&body.password, &user.password_hash) {
        Ok(valid) => valid,
        Err(err) => {
            info!(%err, "password hash verification failed");
            return Err(http_error(500, "password verification error"));
        }
    };
    if !password_valid {
        // Don't return 401, that would trigger "user-is-logged-out" behavior
        return Err(http_error(403, "invalid password"));
    }

    // If nothing to change, succeed as a no-op
    if body.new_password.is_none() && body.new_email.is_none() {
        return Ok(StatusCode::NO_CONTENT);
    }

    // If changing email, check that the new email isn't already in use
    if let Some(ref new_email) = body.new_email {
        common::check_email_available(&state.dynamo_client, &state.users_table_name, new_email).await?;
    }

    // If changing password, generate new hash
    let new_password_hash = match body.new_password {
        Some(ref new_password) => {
            let hash = match (cryptographic_ops.generate_password_hash)(new_password) {
                Ok(hash) => hash,
                Err(err) => {
                    info!(%err, "password hash generation failed");
                    return Err(http_error(500, "password hash generation error"));
                }
            };
            Some(hash)
        }
        None => None,
    };

    // Build the update expression dynamically
    let mut set_parts: Vec<String> = Vec::new();
    let mut update = state.dynamo_client
        .update_item()
        .table_name(&state.users_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()));

    if let Some(ref new_email) = body.new_email {
        set_parts.push("email = :email".to_string());
        update = update.expression_attribute_values(":email", AttributeValue::S(new_email.clone()));
    }
    if let Some(ref new_hash) = new_password_hash {
        set_parts.push("password_hash = :password_hash".to_string());
        update = update.expression_attribute_values(":password_hash", AttributeValue::S(new_hash.clone()));
    }

    let update_expression = format!("SET {}", set_parts.join(", "));
    let result = update
        .update_expression(update_expression)
        .send()
        .await;

    match result {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(err) => {
            info!(%err, "user update failed");
            Err(http_error(500, "unable to update user"))
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::passwords;
    use crate::test_helpers::*;

    fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
        Ok("new_stub_hash".to_string())
    }
    fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
        Ok(true)
    }
    fn stub_verify_fail(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
        Ok(false)
    }

    fn test_crypto_ops() -> CryptographicOps {
        CryptographicOps {
            generate_password_hash: stub_generate_hash,
            verify_password: stub_verify,
        }
    }

    const USER_ITEM_RESPONSE: &str = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"email":{"S":"test@example.com"},"password_hash":{"S":"hashed_pw"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"}}}"#;

    #[tokio::test]
    async fn direct_handle_edit_user_change_email() {
        let email_not_taken = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
            replay_ok(email_not_taken),
            replay_ok(update_response),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            test_crypto_ops(),
            Json(UserEditBody {
                password: "currentpass".to_string(),
                new_password: None,
                new_email: Some("new@example.com".to_string()),
            }),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_edit_user_change_password() {
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
            replay_ok(update_response),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            test_crypto_ops(),
            Json(UserEditBody {
                password: "currentpass".to_string(),
                new_password: Some("newpass123".to_string()),
                new_email: None,
            }),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_edit_user_change_both() {
        let email_not_taken = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
            replay_ok(email_not_taken),
            replay_ok(update_response),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            test_crypto_ops(),
            Json(UserEditBody {
                password: "currentpass".to_string(),
                new_password: Some("newpass123".to_string()),
                new_email: Some("new@example.com".to_string()),
            }),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_edit_user_not_logged_in() {
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_no_user_session(),
            test_crypto_ops(),
            Json(UserEditBody {
                password: "currentpass".to_string(),
                new_password: Some("newpass123".to_string()),
                new_email: None,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn direct_handle_edit_user_wrong_password() {
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            CryptographicOps {
                generate_password_hash: stub_generate_hash,
                verify_password: stub_verify_fail,
            },
            Json(UserEditBody {
                password: "wrongpass".to_string(),
                new_password: Some("newpass123".to_string()),
                new_email: None,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "invalid password");
    }

    #[tokio::test]
    async fn direct_handle_edit_user_email_taken() {
        let email_taken = r#"{"Items":[{"user_id":{"S":"OTHER_USER"},"email":{"S":"taken@example.com"},"password_hash":{"S":"some_hash"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-01-01T00:00:00.000000000Z"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
            replay_ok(email_taken),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            test_crypto_ops(),
            Json(UserEditBody {
                password: "currentpass".to_string(),
                new_password: None,
                new_email: Some("taken@example.com".to_string()),
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["error"], "email already in use");
    }

    #[tokio::test]
    async fn direct_handle_edit_user_no_changes() {
        let client = test_dynamo_client(vec![
            replay_ok(USER_ITEM_RESPONSE),
        ]);

        let result = handle_edit_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            test_crypto_ops(),
            Json(UserEditBody {
                password: "currentpass".to_string(),
                new_password: None,
                new_email: None,
            }),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }
}
