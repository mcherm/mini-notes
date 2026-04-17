use aws_sdk_dynamodb::operation::delete_item::DeleteItemError;
use aws_sdk_dynamodb::types::{AttributeValue, ReturnValuesOnConditionCheckFailure};
use axum::{
    extract::{Path, State},
    http::StatusCode,
};
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, http_error, UserSession};
use crate::utils::is_valid_id;


/// Handler for permanently deleting a soft-deleted note. Uses a conditional
/// delete_item that requires both existence and delete_time. Returns 204 on
/// success or if the note doesn't exist (idempotent). Returns 412 if the note
/// exists but is not soft-deleted.
#[axum::debug_handler]
pub async fn handle_destroy_deleted_note(
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

    info!(user_id, note_id, table = state.notes_table_name, "destroy deleted note");

    let result = state.dynamo_client
        .delete_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .condition_expression("attribute_exists(user_id) AND attribute_exists(delete_time)")
        .return_values_on_condition_check_failure(ReturnValuesOnConditionCheckFailure::AllOld)
        .send()
        .await;

    match result {
        Ok(_) => Ok(StatusCode::NO_CONTENT),
        Err(sdk_err) => {
            match sdk_err.as_service_error() {
                Some(DeleteItemError::ConditionalCheckFailedException(e)) => {
                    if e.item().is_some() {
                        Err(http_error(412, "note is not deleted"))
                    } else {
                        Ok(StatusCode::NO_CONTENT)
                    }
                }
                _ => Err(http_error(500, "unable to destroy note")),
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_destroy_deleted_note_happy_path() {
        let delete_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(delete_response)]);

        let result = handle_destroy_deleted_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_destroy_deleted_note_not_found() {
        let client = test_dynamo_client(vec![replay_conditional_check_failed()]);

        let result = handle_destroy_deleted_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_destroy_deleted_note_not_deleted() {
        let client = test_dynamo_client(vec![replay_conditional_check_failed_with_item()]);

        let result = handle_destroy_deleted_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::PRECONDITION_FAILED);
    }

    #[tokio::test]
    async fn direct_handle_destroy_deleted_note_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_destroy_deleted_note(
            test_state(client),
            test_no_user_session(),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
    }
}
