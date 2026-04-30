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

/// When traversing the base table used by search_notes, DynamoDB gives us back a
/// "LastEvaluatedKey" map with the 2 fields user_id and note_id. This function converts
/// that to a pipe-delimited string in the format "user_id|note_id" (or fails).
fn build_search_notes_continue_key(last_evaluated_key: DynamoDBRecord) -> Result<String, String> {
    let user_id = get_s(&last_evaluated_key, "user_id")?;
    let note_id = get_s(&last_evaluated_key, "note_id")?;
    Ok(format!("{user_id}|{note_id}"))
}

/// Parse a continue_key string (as returned by build_search_notes_continue_key()) back into a
/// DynamoDBRecord suitable for use as an exclusive_start_key.
fn parse_search_notes_continue_key(continue_key: &str) -> Result<DynamoDBRecord, String> {
    let parts: Vec<&str> = continue_key.split('|').collect();
    let [user_id, note_id] = parts.as_slice() else {
        return Err("continue_key must have exactly 2 pipe-delimited fields".to_string());
    };
    let mut key = DynamoDBRecord::new();
    key.insert("user_id".to_string(), AttributeValue::S(user_id.to_string()));
    key.insert("note_id".to_string(), AttributeValue::S(note_id.to_string()));
    Ok(key)
}

/// Query parameter extractor for search_notes.
#[derive(Deserialize)]
pub struct SearchNotesParams {
    pub search_string: String,
    pub continue_key: Option<String>,
}

/// Handler for getting a list of notes (with pagination). Does not return them in any
/// particular order (it's sorted by note_id, which is randomly assigned). Returns a
/// continue_key for pagination if there *may* be more to be found. Will always return
/// at least 1 matching note unless we are at the end of the list of matches. Matching
/// notes are those that have the search string somewhere in the title or body,
/// compared case-insensitively.
#[axum::debug_handler]
pub async fn handle_search_notes(
    State(state): State<AppState>,
    user_session: UserSession,
    Query(query_params): Query<SearchNotesParams>
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, table = state.notes_table_name, query_params.search_string, ?query_params.continue_key, "searching for notes");

    // Parse the continuation key if provided
    let mut exclusive_start_key: Option<DynamoDBRecord> = match query_params.continue_key {
        Some(key) => match parse_search_notes_continue_key(&key) {
            Ok(record) => Some(record),
            Err(_) => return Err(http_error(400, "invalid continue_key")),
        },
        None => None,
    };

    // DynamoDB's filter expression language has no case-folding function, so we apply
    // the case-insensitive match in Rust over the raw items returned.
    let search_lower = query_params.search_string.to_lowercase();

    let mut note_headers: Vec<NoteHeader> = Vec::new();

    loop {

        // Perform the query
        let result = state.dynamo_client
            .query()
            .table_name(&state.notes_table_name)
            .key_condition_expression("user_id = :uid")
            .filter_expression("attribute_not_exists(delete_time)")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
            .limit(NOTES_PER_BATCH)
            .set_exclusive_start_key(exclusive_start_key)
            .send()
            .await;
        let result = match result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &err.to_string())),
        };

        exclusive_start_key = result.last_evaluated_key;

        // Apply case-insensitive search over title/body, then convert matches to NoteHeader.
        for item in result.items.unwrap_or_default() {
            let (Ok(title), Ok(body)) = (get_s(&item, "title"), get_s(&item, "body")) else {
                return Err(http_error(500, "a note is invalid in DB"));
            };
            if title.to_lowercase().contains(&search_lower) || body.to_lowercase().contains(&search_lower) {
                let Ok(header) = NoteHeader::try_from(item) else {
                    return Err(http_error(500, "a note is invalid in DB"));
                };
                note_headers.push(header);
            }
        }

        // Exit when there are no more pages, or we've gathered at least NOTES_PER_BATCH of them
        if exclusive_start_key.is_none() || note_headers.len() >= NOTES_PER_BATCH as usize {
            break;
        }
    }

    // Turn exclusive_start_key (DynamoDB format) into continue_key (my string encoding)
    let Ok(continue_key) = exclusive_start_key.map(build_search_notes_continue_key).transpose() else {
        return Err(http_error(500, "continue_key invalid in DB"));
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

    #[tokio::test]
    async fn direct_handle_search_notes_happy_path() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"Matching Note"},"body":{"S":"some body text"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_search_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(SearchNotesParams {
                search_string: "Matching".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "ab12cd34ef");
        assert_eq!(headers[0]["title"], "Matching Note");
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_no_matches() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":5}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_search_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(SearchNotesParams {
                search_string: "nonexistent".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_pagination_finds_results_on_second_page() {
        // First page: no matches but has a LastEvaluatedKey (loop continues)
        let page1 = r#"{"Items":[],"Count":0,"ScannedCount":5,"LastEvaluatedKey":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"}}}"#;
        // Second page: has a match and no LastEvaluatedKey (loop exits)
        let page2 = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"zz99yy88ww"},"version_id":{"N":"1"},"title":{"S":"Found It"},"body":{"S":"some body text"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":5}"#;
        let client = test_dynamo_client(vec![replay_ok(page1), replay_ok(page2)]);

        let result = handle_search_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(SearchNotesParams {
                search_string: "Found".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "zz99yy88ww");
        assert_eq!(headers[0]["title"], "Found It");
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_pagination_exhausted_no_matches() {
        // Single page: no matches and no LastEvaluatedKey (loop exits immediately)
        let page1 = r#"{"Items":[],"Count":0,"ScannedCount":5}"#;
        let client = test_dynamo_client(vec![replay_ok(page1)]);

        let result = handle_search_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(SearchNotesParams {
                search_string: "nothing".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_case_insensitive_match() {
        // Three items: title-only match (mixed case), body-only match (upper case),
        // and a non-match. Search string is lowercase; both partial-case items should match.
        let query_response = r#"{"Items":[
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"aa11bb22cc"},"version_id":{"N":"1"},"title":{"S":"My Recipe Book"},"body":{"S":"nothing here"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}},
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"dd33ee44ff"},"version_id":{"N":"1"},"title":{"S":"shopping list"},"body":{"S":"buy more RECIPE ingredients"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}},
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"gg55hh66ii"},"version_id":{"N":"1"},"title":{"S":"unrelated"},"body":{"S":"nothing matching"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}
        ],"Count":3,"ScannedCount":3}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_search_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Query(SearchNotesParams {
                search_string: "recipe".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[0]["note_id"], "aa11bb22cc");
        assert_eq!(headers[1]["note_id"], "dd33ee44ff");
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_not_logged_in() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_search_notes(
            test_state(client),
            test_no_user_session(),
            Query(SearchNotesParams {
                search_string: "test".to_string(),
                continue_key: None,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
