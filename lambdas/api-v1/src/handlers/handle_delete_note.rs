use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::{Path, State},
    response::Json,
};
use serde_json::json;
use time::format_description::well_known::Iso8601;
use tracing::info;

use crate::extractors::{AppState, CurrentTime, HandlerOutput, http_error, UserSession};
use crate::utils::SOFT_DELETE_DAYS;


/// Logic for handling the delete_note command. Performs a soft delete by setting
/// delete_time and ttl_delete; DynamoDB TTL will purge the item later.
#[axum::debug_handler]
pub async fn handle_delete_note(
    State(state): State<AppState>,
    user_session: UserSession,
    current_time: CurrentTime,
    Path(note_id): Path<String>,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, note_id, table = state.notes_table_name, "soft-delete note");

    let delete_at = current_time.date_time + time::Duration::days(SOFT_DELETE_DAYS);
    let delete_time_string = match delete_at.format(&Iso8601::DEFAULT) {
        Ok(s) => s,
        Err(_) => return Err(http_error(500, "cannot format delete time")),
    };
    let ttl_delete_string = delete_at.unix_timestamp().to_string();

    let result = state.dynamo_client
        .update_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .update_expression("SET delete_time = :dt, ttl_delete = :ttl")
        .expression_attribute_values(":dt", AttributeValue::S(delete_time_string))
        .expression_attribute_values(":ttl", AttributeValue::N(ttl_delete_string))
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
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_delete_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, json!({}));
    }

    #[tokio::test]
    async fn direct_handle_delete_note_nonexistent() {
        // DynamoDB UpdateItem succeeds even when the item doesn't exist
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_delete_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, json!({}));
    }

    #[tokio::test]
    async fn direct_handle_delete_note_not_logged_in() {
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_delete_note(
            test_state(client),
            test_no_user_session(),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
