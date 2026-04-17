use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::{Path, State},
    http::StatusCode,
};
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, http_error, UserSession};
use crate::utils::is_valid_id;


/// Handler for recovering a soft-deleted note. Removes delete_time and ttl_delete
/// so the note becomes a normal note again. Idempotent: succeeds even if the note
/// is not currently deleted. Returns 404 if the note does not exist.
#[axum::debug_handler]
pub async fn handle_recover_note(
    State(state): State<AppState>,
    user_session: UserSession,
    Path(note_id): Path<String>,
) -> Result<StatusCode, HandlerErrOutput> {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    if !is_valid_id(&note_id) {
        return Err(http_error(404, "note_id has invalid characters"));
    }

    info!(user_id, note_id, table = state.notes_table_name, "recover note");

    let result = state.dynamo_client
        .update_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .update_expression("REMOVE delete_time, ttl_delete")
        .condition_expression("attribute_exists(user_id)")
        .send()
        .await;

    match result {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(sdk_err) => {
            if sdk_err.as_service_error()
                .map(|e| e.is_conditional_check_failed_exception())
                .unwrap_or(false)
            {
                Err(http_error(404, "note not found"))
            } else {
                Err(http_error(500, "unable to recover note"))
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_recover_note_happy_path() {
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_recover_note_not_found() {
        let client = test_dynamo_client(vec![replay_conditional_check_failed()]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn direct_handle_recover_note_not_deleted() {
        // REMOVE on nonexistent attributes is a no-op, so this succeeds
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(update_response)]);

        let result = handle_recover_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_recover_note_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_recover_note(
            test_state(client),
            test_no_user_session(),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    }
}
