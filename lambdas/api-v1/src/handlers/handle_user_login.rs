use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
    http::header,
};
use serde::Deserialize;
use serde_json::json;
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, CurrentTime, IdGenerator, CryptographicOps, http_error};
use crate::handlers::common::{self, SERVER_ERROR_MESSAGE};
use crate::models::{User, Session};
use crate::utils::{SESSION_LIFETIME_DAYS, effective_expire_time};


/// A struct for the things that are passed in as part of the body when a user login occurs.
#[derive(Debug, Deserialize)]
pub struct UserLoginBody {
    pub email: String,
    pub password: String,
}

/// Handler for user login.
#[axum::debug_handler]
pub async fn handle_user_login(
    State(state): State<AppState>,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    cryptographic_ops: CryptographicOps,
    Json(user_login_body): Json<UserLoginBody>,
) -> Result<([(header::HeaderName, header::HeaderValue); 1], Json<serde_json::Value>), HandlerErrOutput> {
    info!(email = user_login_body.email, "user login attempt");

    let email = common::normalize_email(&user_login_body.email);

    // Look up the user by email using the GSI
    let query_result = state.dynamo_client
        .query()
        .table_name(&state.users_table_name)
        .index_name("users-by-email")
        .key_condition_expression("email = :email")
        .expression_attribute_values(":email", AttributeValue::S(email))
        .limit(1)
        .send()
        .await;
    let query_result = match query_result {
        Ok(response) => response,
        Err(err) => {
            info!(%err, "users-by-email query failed");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };
    let Some(first_user) = query_result
        .items
        .and_then(|mut items| if items.is_empty() { None } else { Some(items.remove(0)) })
    else {
        return Err(http_error(401, "invalid email or password"))
    };
    let user: User = match User::try_from(first_user) {
        Ok(user) => user,
        Err(err) => {
            info!(err, "user record is invalid in DB");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };

    // Verify the password
    let password_valid = match (cryptographic_ops.verify_password)(&user_login_body.password, &user.password_hash) {
        Ok(valid) => valid,
        Err(err) => {
            info!(%err, "password hash verification failed");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };
    if !password_valid {
        return Err(http_error(401, "invalid email or password"));
    }

    // Create a session. At creation last_used == create_time == now, so the effective
    // expiry is the sliding idle window (now + idle limit).
    let session_id = generate_id();
    let now = current_time.timestamp;
    let session = Session {
        session_id,
        user_id: user.user_id,
        create_time: now,
        last_used: now,
        expire_time: effective_expire_time(now, now),
    };

    // Write the new session to the Sessions table
    let result = state.dynamo_client
        .put_item()
        .table_name(&state.sessions_table_name)
        .set_item(Some(session.to_item()))
        .send()
        .await;
    if let Err(err) = result {
        info!(%err, "failed to write session to sessions table");
        return Err(http_error(500, SERVER_ERROR_MESSAGE));
    }

    // Return a response with a Set-Cookie header containing the session_id. The cookie
    // Max-Age matches the absolute session cap, so the browser keeps presenting it for as
    // long as the server might honor it; the server is the authority on validity (sliding
    // idle window) via its own expiry check.
    let cookie_value = format!(
        "session_id={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}",
        session.session_id,
        SESSION_LIFETIME_DAYS * 24 * 60 * 60,  // SESSION_LIFETIME_DAYS in seconds
    );
    let headers = [(header::SET_COOKIE, cookie_value.parse().unwrap())];
    let body = Json(json!({"session_id": session.session_id}));
    Ok((headers, body))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::passwords;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_user_login_happy_path() {
        // First call: query users-by-email GSI returns a user
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"email":{"S":"test@example.com"},"password_hash":{"S":"fake_hash"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"}}],"Count":1,"ScannedCount":1}"#;
        // Second call: put_item to sessions table succeeds
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(query_response),
            replay_ok(put_response),
        ]);

        fn fake_id() -> String { "SESS123456".to_string() }
        fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
            Ok("stub_hash".to_string())
        }
        fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
            Ok(true)
        }

        let result = handle_user_login(
            test_state(client),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            CryptographicOps {
                generate_password_hash: stub_generate_hash,
                verify_password: stub_verify,
            },
            Json(UserLoginBody {
                email: "test@example.com".to_string(),
                password: "testpass".to_string(),
            }),
        ).await;

        let (headers, Json(json)) = result.unwrap();
        assert_eq!(json["session_id"], "SESS123456");
        let cookie = headers[0].1.to_str().unwrap();
        assert!(cookie.starts_with("session_id=SESS123456;"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Secure"));
    }

    #[tokio::test]
    async fn direct_handle_user_login_user_not_found() {
        // GSI query returns no items
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        fn fake_id() -> String { "SESS123456".to_string() }
        fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
            Ok("stub_hash".to_string())
        }
        fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
            Ok(true)
        }

        let result = handle_user_login(
            test_state(client),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            CryptographicOps {
                generate_password_hash: stub_generate_hash,
                verify_password: stub_verify,
            },
            Json(UserLoginBody {
                email: "nobody@example.com".to_string(),
                password: "testpass".to_string(),
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "invalid email or password");
    }

    #[tokio::test]
    async fn direct_handle_user_login_wrong_password() {
        // GSI query returns a user
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"email":{"S":"test@example.com"},"password_hash":{"S":"fake_hash"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        fn fake_id() -> String { "SESS123456".to_string() }
        fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
            Ok("stub_hash".to_string())
        }
        fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
            Ok(false)
        }

        let result = handle_user_login(
            test_state(client),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            CryptographicOps {
                generate_password_hash: stub_generate_hash,
                verify_password: stub_verify,
            },
            Json(UserLoginBody {
                email: "test@example.com".to_string(),
                password: "wrongpass".to_string(),
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "invalid email or password");
    }
}
