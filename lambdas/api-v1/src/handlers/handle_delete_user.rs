use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    http::StatusCode,
};
use tracing::info;

use crate::extractors::{AppState, HandlerErrOutput, http_error, UserSession};
use crate::models::get_s;


/// Logic for handling the delete_user command. Deletes the logged-in user,
/// all of their notes, and all of their sessions.
#[axum::debug_handler]
pub async fn handle_delete_user(
    State(state): State<AppState>,
    user_session: UserSession,
) -> Result<StatusCode, HandlerErrOutput> {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, "delete user and all associated data");

    // --- Delete all notes for this user ---
    // Query by partition key (user_id), then batch-delete the results.
    // Loop in case there are more notes than fit in one query page.
    loop {
        let query_result = state.dynamo_client
            .query()
            .table_name(&state.notes_table_name)
            .key_condition_expression("user_id = :uid")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.clone()))
            .projection_expression("user_id, note_id")
            .send()
            .await;
        let query_result = match query_result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &format!("failed to query notes: {err}"))),
        };

        let items = query_result.items.unwrap_or_default();
        if items.is_empty() {
            break;
        }

        for item in &items {
            let note_id = match get_s(item, "note_id") {
                Ok(id) => id,
                Err(_) => continue,
            };
            let result = state.dynamo_client
                .delete_item()
                .table_name(&state.notes_table_name)
                .key("user_id", AttributeValue::S(user_id.clone()))
                .key("note_id", AttributeValue::S(note_id))
                .send()
                .await;
            if let Err(err) = result {
                return Err(http_error(500, &format!("failed to delete note: {err}")));
            }
        }

        // If the query didn't return a last_evaluated_key, we're done
        if query_result.last_evaluated_key.is_none() {
            break;
        }
    }

    // --- Delete all sessions for this user ---
    // The sessions table has session_id as PK, so we scan with a filter on user_id.
    let mut exclusive_start_key = None;
    loop {
        let mut scan_builder = state.dynamo_client
            .scan()
            .table_name(&state.sessions_table_name)
            .filter_expression("user_id = :uid")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.clone()))
            .projection_expression("session_id");
        if let Some(start_key) = exclusive_start_key {
            scan_builder = scan_builder.set_exclusive_start_key(Some(start_key));
        }

        let scan_result = match scan_builder.send().await {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &format!("failed to scan sessions: {err}"))),
        };

        let items = scan_result.items.unwrap_or_default();
        for item in &items {
            let session_id = match get_s(item, "session_id") {
                Ok(id) => id,
                Err(_) => continue,
            };
            let _ = state.dynamo_client
                .delete_item()
                .table_name(&state.sessions_table_name)
                .key("session_id", AttributeValue::S(session_id))
                .send()
                .await;
        }

        if scan_result.last_evaluated_key.is_none() {
            break;
        }
        exclusive_start_key = scan_result.last_evaluated_key;
    }

    // --- Delete the user record ---
    let result = state.dynamo_client
        .delete_item()
        .table_name(&state.users_table_name)
        .key("user_id", AttributeValue::S(user_id.clone()))
        .send()
        .await;
    if let Err(err) = result {
        return Err(http_error(500, &format!("failed to delete user: {err}")));
    }

    info!(user_id, "user deleted successfully");
    Ok(StatusCode::NO_CONTENT)
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::response::Json;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_delete_user_happy_path() {
        // Query notes returns one note, then empty on second query
        let query_notes_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"}}],"Count":1,"ScannedCount":1}"#;
        let delete_note_response = r#"{}"#;
        let query_notes_empty = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        // Scan sessions returns one session
        let scan_sessions_response = r#"{"Items":[{"session_id":{"S":"test-session-id"}}],"Count":1,"ScannedCount":1}"#;
        let delete_session_response = r#"{}"#;
        // Delete user
        let delete_user_response = r#"{}"#;

        let client = test_dynamo_client(vec![
            replay_ok(query_notes_response),
            replay_ok(delete_note_response),
            replay_ok(query_notes_empty),
            replay_ok(scan_sessions_response),
            replay_ok(delete_session_response),
            replay_ok(delete_user_response),
        ]);

        let result = handle_delete_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_delete_user_no_notes_no_extra_sessions() {
        let query_notes_empty = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let scan_sessions_empty = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let delete_user_response = r#"{}"#;

        let client = test_dynamo_client(vec![
            replay_ok(query_notes_empty),
            replay_ok(scan_sessions_empty),
            replay_ok(delete_user_response),
        ]);

        let result = handle_delete_user(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn direct_handle_delete_user_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_delete_user(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
