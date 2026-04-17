use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::models::{DynamoDBRecord, NoteHeader, get_s};
use crate::utils::NOTES_PER_BATCH;


/// Controls whether to query normal (non-deleted) notes or soft-deleted notes.
pub enum NoteFilter {
    NormalNotes,
    DeletedNotes,
}

/// When traversing the index used by get_notes, DynamoDB gives us back a "LastEvaluatedKey"
/// map with the 3 fields user_id, note_id, and modify_time when we are reading from the LSI.
/// This converts that to a pipe-delimited string in the format "user_id|modify_time|note_id"
/// (or fails).
fn build_get_notes_continue_key(last_evaluated_key: DynamoDBRecord) -> Result<String, String> {
    let user_id = get_s(&last_evaluated_key, "user_id")?;
    let note_id = get_s(&last_evaluated_key, "note_id")?;
    let modify_time = get_s(&last_evaluated_key, "modify_time")?;
    Ok(format!("{user_id}|{modify_time}|{note_id}"))
}

/// Parse a continue_key string (as returned by build_get_notes_continue_key()) back into a
/// DynamoDBRecord suitable for use as an exclusive_start_key.
fn parse_get_notes_continue_key(continue_key: &str) -> Result<DynamoDBRecord, String> {
    let parts: Vec<&str> = continue_key.split('|').collect();
    let [user_id, modify_time, note_id] = parts.as_slice() else {
        return Err("continue_key must have exactly 3 pipe-delimited fields".to_string());
    };
    let mut key = DynamoDBRecord::new();
    key.insert("user_id".to_string(), AttributeValue::S(user_id.to_string()));
    key.insert("note_id".to_string(), AttributeValue::S(note_id.to_string()));
    key.insert("modify_time".to_string(), AttributeValue::S(modify_time.to_string()));
    Ok(key)
}

/// Query parameter extractor for get_notes.
#[derive(Deserialize)]
pub struct GetNotesParams {
    pub continue_key: Option<String>,
}

/// Handler for getting a list of notes (with pagination). Returns them by modify_date descending.
#[axum::debug_handler]
pub async fn handle_get_notes(
    State(state): State<AppState>,
    user_session: UserSession,
    Query(query_params): Query<GetNotesParams>
) -> HandlerOutput {
    get_notes_impl(&state, user_session, query_params.continue_key, NoteFilter::NormalNotes).await
}

/// Shared implementation for querying notes with pagination. Used by both
/// handle_get_notes (NormalNotes) and handle_get_deleted_notes (DeletedNotes).
pub async fn get_notes_impl(
    state: &AppState,
    user_session: UserSession,
    continue_key: Option<String>,
    note_filter: NoteFilter,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = &session.user_id;
    let filter_expr = match note_filter {
        NoteFilter::NormalNotes => "attribute_not_exists(delete_time)",
        NoteFilter::DeletedNotes => "attribute_exists(delete_time)",
    };

    info!(user_id, table = state.notes_table_name, filter_expr, "fetching notes");

    // Parse the continuation key if provided
    let exclusive_start_key: Option<DynamoDBRecord> = match continue_key {
        Some(key) => match parse_get_notes_continue_key(&key) {
            Ok(record) => Some(record),
            Err(_) => return Err(http_error(400, "invalid continue_key")),
        },
        None => None,
    };

    // Perform the query
    let result = state.dynamo_client
        .query()
        .table_name(&state.notes_table_name)
        .index_name("notes-by-modify-time")
        .key_condition_expression("user_id = :uid")
        .filter_expression(filter_expr)
        .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
        .limit(NOTES_PER_BATCH)
        .scan_index_forward(false)
        .set_exclusive_start_key(exclusive_start_key)
        .send()
        .await;
    let result = match result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };

    // And extract and return the results
    let Ok(continue_key) = result.last_evaluated_key
        .map(build_get_notes_continue_key)
        .transpose()
    else {
        return Err(http_error(500, "continue_key invalid in DB"));
    };
    let Ok(note_headers): Result<Vec<NoteHeader>, String> = result.items
        .unwrap_or_default()
        .into_iter()
        .map(NoteHeader::try_from)
        .collect()
    else {
        return Err(http_error(500, "note header is invalid in DB"));
    };
    let note_headers_json: JsonValue = note_headers.into_iter().map(JsonValue::from).collect();
    let body_json = json!({
        "note_headers": note_headers_json,
        "continue_key": continue_key,
    });
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[test]
    fn parse_get_notes_params_ignores_extra_params() {
        let uri: axum::http::Uri = "http://example.com/path?foo=hello&bar=42".parse().unwrap();
        let query: Query<GetNotesParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.continue_key, None);
    }

    #[test]
    fn parse_get_notes_params_parses_simple_strings() {
        let uri: axum::http::Uri = "http://example.com/path?continue_key=abc".parse().unwrap();
        let query: Query<GetNotesParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.continue_key, Some("abc".to_string()));
    }

    #[test]
    fn parse_get_notes_params_parses_real_example_with_escaped_values() {
        let uri: axum::http::Uri = "http://example.com/path?continue_key=Xq3_mK8~pL%7C2026-03-10T22%3A19%3A00.000Z%7Ck7Rp~2mXvQ".parse().unwrap();
        let query: Query<GetNotesParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.continue_key, Some("Xq3_mK8~pL|2026-03-10T22:19:00.000Z|k7Rp~2mXvQ".to_string()));
    }

    #[tokio::test]
    async fn direct_handle_get_notes_happy_path() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"My Note"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "ab12cd34ef");
        assert_eq!(headers[0]["title"], "My Note");
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_get_notes_with_continue_key() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"zz99yy88ww"},"version_id":{"N":"1"},"title":{"S":"Second Page Note"},"modify_time":{"S":"2026-03-05T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(GetNotesParams {
                continue_key: Some("Xq3_mK8~pL|2026-03-10T00:00:00.000000000Z|ab12cd34ef".to_string()),
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "zz99yy88ww");
        assert_eq!(headers[0]["title"], "Second Page Note");
    }

    #[tokio::test]
    async fn direct_handle_get_notes_empty_results() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }


    #[tokio::test]
    async fn direct_handle_get_notes_not_logged_in() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            test_no_user_session(),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
