use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::{Path, State},
    response::Json,
};
use serde_json::json;
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, http_error};

/// Logic for handling the delete_note command.
#[axum::debug_handler]
pub async fn handle_delete_note(
    State(state): State<AppState>,
    Path(note_id): Path<String>
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    info!(user_id, note_id, table = state.notes_table_name, "delete note");

    let result = state.dynamo_client
        .delete_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await;
    if result.is_err() {
        return Err(http_error(500, "unable to delete note"));
    }

    let body_json = json!({});
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_delete_note_happy_path() {
        let delete_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(delete_response)]);

        let result = handle_delete_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, json!({}));
    }

    #[tokio::test]
    async fn direct_handle_delete_note_nonexistent() {
        // DynamoDB DeleteItem succeeds even when the item doesn't exist
        let delete_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(delete_response)]);

        let result = handle_delete_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, json!({}));
    }
}
