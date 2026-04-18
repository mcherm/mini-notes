use axum::{
    extract::State,
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::handlers::common;

/// Logic for handling the get_user command.
#[axum::debug_handler]
pub async fn handle_get_user(
    State(state): State<AppState>,
    user_session: UserSession,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    let user = common::fetch_user_by_id(&state.dynamo_client, &state.users_table_name, &user_id).await?;
    let user_json: JsonValue = user.into();

    let body_json = json!({"user": user_json});
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_get_user_happy_path() {
        let get_item_response = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"email":{"S":"test@example.com"},"password_hash":{"S":"hashed_pw"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"}}}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["user"]["email"], "test@example.com");
        assert_eq!(json["user"]["user_type"], "Earlybird");
        assert_eq!(json["user"]["create_time"], "2026-03-01T00:00:00Z");
        assert!(json["user"].get("user_id").is_none(), "user_id is not currently exposed");
        assert!(json["user"].get("password_hash").is_none(), "password_hash must not be exposed");
    }

    #[tokio::test]
    async fn direct_handle_get_user_not_found() {
        let get_item_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(json["error"], "user for session not found");
    }

    #[tokio::test]
    async fn direct_handle_get_user_not_logged_in() {
        let get_item_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_user(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
