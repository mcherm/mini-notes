use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::{Path, State},
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::models::{DynamoDBRecord, Note};
use crate::utils::is_valid_id;

/// Logic for handling the get_note command.
#[axum::debug_handler]
pub async fn handle_get_note(
    State(state): State<AppState>,
    user_session: UserSession,
    Path(note_id): Path<String>,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    if ! is_valid_id(&note_id) {
        return Err(http_error(404, "note_id has invalid characters"));
    }

    info!(user_id, note_id, table = state.notes_table_name, "fetching note");

    let result = state.dynamo_client
        .get_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await;
    let result = match result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };
    let item: DynamoDBRecord = match result.item {
        Some(item) => item,
        None => return Err(http_error(404, "note not found")),
    };
    let note: JsonValue = match Note::try_from(item) {
        Ok(note) => note.into(),
        Err(err) => {
            info!(err, "note is invalid in DB");
            return Err(http_error(500, "note is invalid in DB"));
        }
    };

    let body_json = json!({"note": note});
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_get_note_happy_path() {
        let get_item_response = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"2"},"title":{"S":"Found Note"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Note body"}}}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["version_id"], 2);
        assert_eq!(json["note"]["title"], "Found Note");
        assert_eq!(json["note"]["body"], "Note body");
    }

    #[tokio::test]
    async fn direct_handle_get_note_not_found() {
        let get_item_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json["error"], "note not found");
    }

    #[tokio::test]
    async fn direct_handle_get_note_not_logged_in() {
        let get_item_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_note(
            test_state(client),
            test_no_user_session(),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
