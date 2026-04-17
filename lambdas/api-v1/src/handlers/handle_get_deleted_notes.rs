use axum::{
    extract::{Query, State},
};

use crate::extractors::{AppState, HandlerOutput, UserSession};
use crate::handlers::handle_get_notes::{GetNotesParams, NoteFilter, get_notes_impl};

/// Handler for getting a list of soft-deleted notes (with pagination).
/// Operates exactly like handle_get_notes but returns only deleted notes.
#[axum::debug_handler]
pub async fn handle_get_deleted_notes(
    State(state): State<AppState>,
    user_session: UserSession,
    Query(query_params): Query<GetNotesParams>,
) -> HandlerOutput {
    get_notes_impl(&state, user_session, query_params.continue_key, NoteFilter::DeletedNotes).await
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::extract::Query;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_get_deleted_notes_happy_path() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"Deleted Note"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_deleted_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let axum::response::Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "ab12cd34ef");
        assert_eq!(headers[0]["title"], "Deleted Note");
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_get_deleted_notes_empty_results() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_deleted_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let axum::response::Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_get_deleted_notes_not_logged_in() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_deleted_notes(
            test_state(client),
            test_no_user_session(),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let (status, axum::response::Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
