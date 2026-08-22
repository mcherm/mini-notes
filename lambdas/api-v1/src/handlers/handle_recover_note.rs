use aws_sdk_dynamodb::operation::update_item::UpdateItemError;
use aws_sdk_dynamodb::types::{AttributeValue, ReturnValue, ReturnValuesOnConditionCheckFailure};
use axum::{
    extract::{Path, State},
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, CurrentTime, HandlerOutput, http_error, UserSession};
use crate::handlers::common::SERVER_ERROR_MESSAGE;
use crate::models::{DynamoDBRecord, Note};
use crate::utils::is_valid_id;


/// Handler for recovering a soft-deleted note. Removes delete_time and ttl_delete
/// so the note becomes a normal note again, sets modify_time, and returns the
/// recovered note. Idempotent: recovering a note that is not deleted makes no
/// change and returns that note. Returns 404 if the note does not exist.
#[axum::debug_handler]
pub async fn handle_recover_note(
    State(state): State<AppState>,
    user_session: UserSession,
    current_time: CurrentTime,
    Path(note_id): Path<String>,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    if !is_valid_id(&note_id) {
        return Err(http_error(404, "Note not found."));
    }

    info!(user_id, note_id, table = state.notes_table_name, "recover note");

    let result = state.dynamo_client
        .update_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .update_expression("SET modify_time = :m REMOVE delete_time, ttl_delete")
        .condition_expression("attribute_exists(user_id) AND attribute_exists(delete_time)")
        .expression_attribute_values(":m", AttributeValue::S(current_time.timestamp.to_string()))
        .return_values(ReturnValue::AllNew)
        .return_values_on_condition_check_failure(ReturnValuesOnConditionCheckFailure::AllOld)
        .send()
        .await;

    match result {
        Ok(output) => {
            let attributes = output.attributes
                .ok_or_else(|| {
                    info!("recover note update_item returned no attributes");
                    http_error(500, SERVER_ERROR_MESSAGE)
                })?;
            note_response(attributes)
        }
        Err(sdk_err) => {
            match sdk_err.as_service_error() {
                Some(UpdateItemError::ConditionalCheckFailedException(e)) => {
                    match e.item() {
                        // The note exists but is not deleted, so leave it as it is.
                        Some(item) => note_response(item.clone()),
                        // There is no such note.
                        None => Err(http_error(404, "Note not found.")),
                    }
                }
                _ => {
                    info!(%sdk_err, "recover note update_item failed");
                    Err(http_error(500, "Unable to recover note"))
                }
            }
        }
    }
}

/// Builds the success response for this handler from the DynamoDB record of the recovered note.
fn note_response(attributes: DynamoDBRecord) -> HandlerOutput {
    let recovered_note = Note::try_from(attributes)
        .map_err(|err| {
            info!(%err, "recovered note is invalid");
            http_error(500, SERVER_ERROR_MESSAGE)
        })?;
    let note_json: JsonValue = recovered_note.into();
    Ok(Json(json!({"note": note_json})))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    /// The DynamoDB record of a note that is not deleted.
    const ACTIVE_NOTE_ITEM: &str = r#"{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"3"},"title":{"S":"Never Deleted"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Note body"},"undo_stack":{"L":[]}}"#;

    #[tokio::test]
    async fn direct_handle_recover_note_happy_path() {
        // AllNew returns the note as it stands after delete_time / ttl_delete were
        // removed and modify_time was set
        let update_response = r#"{"Attributes":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"3"},"title":{"S":"Recovered Note"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-15T12:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Note body"},"undo_stack":{"L":[]}}}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["version_id"], 3);
        assert_eq!(json["note"]["title"], "Recovered Note");
        assert_eq!(json["note"]["body"], "Note body");
        assert_eq!(json["note"]["modify_time"], "2026-03-15T12:00:00Z");
        assert!(json["note"].get("delete_time").is_none());
    }

    #[tokio::test]
    async fn direct_handle_recover_note_invalid_note() {
        // The returned attributes don't parse as a Note (version_id is missing)
        let update_response = r#"{"Attributes":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"title":{"S":"Recovered Note"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Note body"}}}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn direct_handle_recover_note_not_found() {
        // The condition fails with no item, which means there was no such note
        let client = test_dynamo_client(vec![replay_conditional_check_failed()]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn direct_handle_recover_note_not_deleted() {
        // The condition fails but the item comes back, so no change is made (in
        // particular, modify_time is not bumped) and the note is returned
        let client = test_dynamo_client(vec![replay_conditional_check_failed_with_item(ACTIVE_NOTE_ITEM)]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["title"], "Never Deleted");
        assert_eq!(json["note"]["modify_time"], "2026-03-10T00:00:00Z");
        assert!(json["note"].get("delete_time").is_none());
    }

    #[tokio::test]
    async fn direct_handle_recover_note_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_recover_note(
            test_state(client),
            test_no_user_session(),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    }
}
