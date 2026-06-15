use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::models::{DynamoDBRecord, Timestamp, UserDetail, get_n_as_u32, get_timestamp};

/// Logic for handling the get_user_detail command. Returns counts of the user's
/// notes (active vs. in trash) plus two cheap collective stats over the active
/// notes — the most recent edit time (max modify_time) and the "busiest note"
/// (max version_id) — all gathered in a single pass over the user's notes.
#[axum::debug_handler]
pub async fn handle_get_user_detail(
    State(state): State<AppState>,
    user_session: UserSession,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, table = state.notes_table_name, "computing user detail");

    let mut notes: u32 = 0;
    let mut notes_in_trash: u32 = 0;
    let mut most_recent_edit: Option<Timestamp> = None;
    let mut busiest_note: Option<u32> = None;
    let mut exclusive_start_key: Option<DynamoDBRecord> = None;

    // A single pass over the notes-by-modify-time LSI. We read only the
    // projected attributes (never the base table, whose body can be up to
    // 100 KB), classify each note as active or trashed by the presence of
    // delete_time, and fold modify_time / version_id into running maxima. No
    // filter and no page limit: we want every note and the fewest round trips.
    loop {
        let result = state.dynamo_client
            .query()
            .table_name(&state.notes_table_name)
            .index_name("notes-by-modify-time")
            .key_condition_expression("user_id = :uid")
            .projection_expression("delete_time, modify_time, version_id")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.clone()))
            .set_exclusive_start_key(exclusive_start_key)
            .send()
            .await;
        let result = match result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &err.to_string())),
        };

        for item in result.items.unwrap_or_default() {
            if item.contains_key("delete_time") {
                notes_in_trash += 1;
            } else {
                notes += 1;

                let modify_time = match get_timestamp(&item, "modify_time") {
                    Ok(ts) => ts,
                    Err(err) => return Err(http_error(500, &err)),
                };
                most_recent_edit = most_recent_edit.max(Some(modify_time));

                let version_id = match get_n_as_u32(&item, "version_id") {
                    Ok(v) => v,
                    Err(err) => return Err(http_error(500, &err)),
                };
                busiest_note = busiest_note.max(Some(version_id));
            }
        }

        exclusive_start_key = result.last_evaluated_key;
        if exclusive_start_key.is_none() {
            break;
        }
    }

    let user_detail = UserDetail {
        user_id,
        notes,
        notes_in_trash,
        most_recent_edit,
        busiest_note,
    };
    let user_detail_json: JsonValue = user_detail.into();

    let body_json = json!({"user_detail": user_detail_json});
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::test_helpers::*;

    const EMPTY_RESPONSE: &str = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;

    #[tokio::test]
    async fn direct_handle_get_user_detail_happy_path() {
        // Two active notes and one trashed note, in a single page. The trashed
        // note deliberately has the latest modify_time and largest version_id,
        // so the maxima must exclude it.
        let query_response = r#"{"Items":[
            {"version_id":{"N":"3"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"}},
            {"version_id":{"N":"7"},"modify_time":{"S":"2026-03-12T00:00:00.000000000Z"}},
            {"version_id":{"N":"99"},"modify_time":{"S":"2026-03-30T00:00:00.000000000Z"},"delete_time":{"S":"2026-03-31T00:00:00.000000000Z"}}
        ],"Count":3,"ScannedCount":3}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        let detail = &json["user_detail"];
        assert_eq!(detail["notes"], 2);
        assert_eq!(detail["notes_in_trash"], 1);
        // Maxima are over active notes only — the trashed note's 99 / 2026-03-30
        // are excluded.
        assert_eq!(detail["most_recent_edit"], "2026-03-12T00:00:00Z");
        assert_eq!(detail["busiest_note"], 7);
        // user_id is intentionally not exposed (matches the get_user convention).
        assert!(detail.get("user_id").is_none());
    }

    #[tokio::test]
    async fn direct_handle_get_user_detail_multi_page() {
        // First page returns one active note plus a LastEvaluatedKey, forcing a
        // second query; second page returns another active note and a trashed
        // note (whose larger stats must be excluded).
        let page_one = r#"{"Items":[
            {"version_id":{"N":"3"},"modify_time":{"S":"2026-03-01T00:00:00.000000000Z"}}
        ],"Count":1,"ScannedCount":1,"LastEvaluatedKey":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"modify_time":{"S":"2026-03-01T00:00:00.000000000Z"}}}"#;
        let page_two = r#"{"Items":[
            {"version_id":{"N":"8"},"modify_time":{"S":"2026-03-25T00:00:00.000000000Z"}},
            {"version_id":{"N":"50"},"modify_time":{"S":"2026-03-28T00:00:00.000000000Z"},"delete_time":{"S":"2026-03-29T00:00:00.000000000Z"}}
        ],"Count":2,"ScannedCount":2}"#;
        let client = test_dynamo_client(vec![replay_ok(page_one), replay_ok(page_two)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        let detail = &json["user_detail"];
        assert_eq!(detail["notes"], 2);
        assert_eq!(detail["notes_in_trash"], 1);
        // Maxima are carried across both pages, over active notes only.
        assert_eq!(detail["most_recent_edit"], "2026-03-25T00:00:00Z");
        assert_eq!(detail["busiest_note"], 8);
    }

    #[tokio::test]
    async fn direct_handle_get_user_detail_all_active() {
        let query_response = r#"{"Items":[
            {"version_id":{"N":"4"},"modify_time":{"S":"2026-03-02T00:00:00.000000000Z"}},
            {"version_id":{"N":"1"},"modify_time":{"S":"2026-03-08T00:00:00.000000000Z"}}
        ],"Count":2,"ScannedCount":2}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        let detail = &json["user_detail"];
        assert_eq!(detail["notes"], 2);
        assert_eq!(detail["notes_in_trash"], 0);
        assert_eq!(detail["most_recent_edit"], "2026-03-08T00:00:00Z");
        assert_eq!(detail["busiest_note"], 4);
    }

    #[tokio::test]
    async fn direct_handle_get_user_detail_all_deleted() {
        let query_response = r#"{"Items":[
            {"version_id":{"N":"9"},"modify_time":{"S":"2026-03-03T00:00:00.000000000Z"},"delete_time":{"S":"2026-03-04T00:00:00.000000000Z"}}
        ],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        let detail = &json["user_detail"];
        assert_eq!(detail["notes"], 0);
        assert_eq!(detail["notes_in_trash"], 1);
        // No active notes, so both maxima are null even though a trashed note exists.
        assert!(detail["most_recent_edit"].is_null());
        assert!(detail["busiest_note"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_get_user_detail_zero_notes() {
        let client = test_dynamo_client(vec![replay_ok(EMPTY_RESPONSE)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        let detail = &json["user_detail"];
        assert_eq!(detail["notes"], 0);
        assert_eq!(detail["notes_in_trash"], 0);
        assert!(detail["most_recent_edit"].is_null());
        assert!(detail["busiest_note"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_get_user_detail_not_logged_in() {
        let client = test_dynamo_client(vec![replay_ok(EMPTY_RESPONSE)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
