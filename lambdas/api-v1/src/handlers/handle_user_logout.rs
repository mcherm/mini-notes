use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
    http::header,
};
use serde_json::json;
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, UserSession};

/// Handler for user logout. Deletes the session from the DB and clears the cookie.
#[axum::debug_handler]
pub async fn handle_user_logout(
    State(state): State<AppState>,
    user_session: UserSession,
) -> Result<([(header::HeaderName, header::HeaderValue); 1], Json<serde_json::Value>), HandlerErrOutput> {
    if let Some(session) = user_session.0 {
        info!(session_id = session.session_id, "user logout, deleting session");

        // Delete the session from DynamoDB (ignore errors)
        let _ = state.dynamo_client
            .delete_item()
            .table_name(&state.sessions_table_name)
            .key("session_id", AttributeValue::S(session.session_id))
            .send()
            .await;
    } else {
        info!("user logout with no active session");
    }

    // Return an expired cookie to clear it in the browser
    let cookie_value = "session_id=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0";
    let headers = [(header::SET_COOKIE, cookie_value.parse().unwrap())];
    let body = Json(json!({}));
    Ok((headers, body))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_user_logout_with_session() {
        let delete_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(delete_response)]);

        let result = handle_user_logout(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let (headers, Json(json)) = result.unwrap();
        assert_eq!(json, json!({}));
        let cookie = headers[0].1.to_str().unwrap();
        assert!(cookie.contains("Max-Age=0"));
        assert!(cookie.contains("session_id=;"));
    }

    #[tokio::test]
    async fn direct_handle_user_logout_without_session() {
        let client = test_dynamo_client(vec![]);

        let result = handle_user_logout(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (headers, Json(json)) = result.unwrap();
        assert_eq!(json, json!({}));
        let cookie = headers[0].1.to_str().unwrap();
        assert!(cookie.contains("Max-Age=0"));
    }
}
