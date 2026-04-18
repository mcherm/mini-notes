use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
    http::header,
};
use serde::Deserialize;
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, CurrentTime, IdGenerator, CryptographicOps, http_error};
use crate::handlers::common;
use crate::handlers::handle_user_login::{UserLoginBody, handle_user_login};
use crate::models::UserType;

/// A struct for the things that are passed in as part of the body when a new user is created.
#[derive(Debug, Deserialize)]
pub struct UserCreateBody {
    pub email: String,
    pub password: String,
}

/// Handler for user creation.
#[axum::debug_handler]
pub async fn handle_user_create(
    State(state): State<AppState>,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    cryptographic_ops: CryptographicOps,
    Json(user_create_body): Json<UserCreateBody>,
) -> Result<([(header::HeaderName, header::HeaderValue); 1], Json<serde_json::Value>), HandlerErrOutput> {
    info!(email = user_create_body.email, "user create attempt");

    // Check that the email isn't already in use
    common::check_email_available(&state.dynamo_client, &state.users_table_name, &user_create_body.email).await?;

    // Generate user_id and password hash
    let user_id = generate_id();
    let password_hash = match (cryptographic_ops.generate_password_hash)(&user_create_body.password) {
        Ok(hash) => hash,
        Err(err) => {
            info!(%err, "password hash generation failed");
            return Err(http_error(500, "password hash generation error"));
        }
    };

    let user_type = UserType::Earlybird; // anyone signing up now is an Earlybird

    // Insert the new user into the users table
    let result = state.dynamo_client
        .put_item()
        .table_name(&state.users_table_name)
        .item("user_id", AttributeValue::S(user_id.clone()))
        .item("email", AttributeValue::S(user_create_body.email.clone()))
        .item("password_hash", AttributeValue::S(password_hash))
        .item("user_type", AttributeValue::S(user_type.to_string()))
        .item("create_time", AttributeValue::S(current_time.timestamp.to_string()))
        .condition_expression("attribute_not_exists(user_id)") // Clobbering a user would be REALLY bad so double-check.
        .send()
        .await;
    if result.is_err() {
        return Err(http_error(500, "unable to create user"));
    }

    // Now perform a login for the newly created user
    handle_user_login(
        State(state),
        current_time,
        IdGenerator(generate_id),
        cryptographic_ops,
        Json(UserLoginBody {
            email: user_create_body.email,
            password: user_create_body.password,
        }),
    ).await
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::passwords;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_user_create_happy_path() {
        // First call: query users-by-email GSI to check email uniqueness (no match)
        let email_check_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        // Second call: put_item to users table succeeds
        let put_user_response = r#"{}"#;
        // Third call: query users-by-email GSI returns the newly created user (for login)
        let query_response = r#"{"Items":[{"user_id":{"S":"D9G1NIkGan"},"email":{"S":"new@example.com"},"password_hash":{"S":"stub_hash"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-03-15T12:00:00.000000000Z"}}],"Count":1,"ScannedCount":1}"#;
        // Fourth call: put_item to sessions table succeeds
        let put_session_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(email_check_response),
            replay_ok(put_user_response),
            replay_ok(query_response),
            replay_ok(put_session_response),
        ]);

        fn fake_id() -> String { "D9G1NIkGan".to_string() }
        fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
            Ok("stub_hash".to_string())
        }
        fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
            Ok(true)
        }

        let result = handle_user_create(
            test_state(client),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            CryptographicOps {
                generate_password_hash: stub_generate_hash,
                verify_password: stub_verify,
            },
            Json(UserCreateBody {
                email: "new@example.com".to_string(),
                password: "newpass123".to_string(),
            }),
        ).await;

        let (headers, Json(json)) = result.unwrap();
        assert_eq!(json["session_id"], "D9G1NIkGan");
        let cookie = headers[0].1.to_str().unwrap();
        assert!(cookie.starts_with("session_id=D9G1NIkGan;"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Secure"));
    }

    #[tokio::test]
    async fn direct_handle_user_create_duplicate_email() {
        // Query users-by-email GSI returns an existing user
        let email_check_response = r#"{"Items":[{"user_id":{"S":"EXISTING123"},"email":{"S":"taken@example.com"},"password_hash":{"S":"some_hash"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-01-01T00:00:00.000000000Z"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![
            replay_ok(email_check_response),
        ]);

        fn fake_id() -> String { "D9G1NIkGan".to_string() }
        fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
            Ok("stub_hash".to_string())
        }
        fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
            Ok(true)
        }

        let result = handle_user_create(
            test_state(client),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            CryptographicOps {
                generate_password_hash: stub_generate_hash,
                verify_password: stub_verify,
            },
            Json(UserCreateBody {
                email: "taken@example.com".to_string(),
                password: "newpass123".to_string(),
            }),
        ).await;

        let err = result.unwrap_err();
        assert_eq!(err.0, axum::http::StatusCode::CONFLICT);
    }

}
