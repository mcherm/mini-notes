use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::models::{DynamoDBRecord, Timestamp, UserDetail, get_n_as_u32, get_timestamp};

/// Running tally of one user's note statistics, accumulated a note at a time.
/// Lives here with the single-user endpoint that primarily uses it, and is
/// reused by handle_get_all_users_detail (which keeps one per user). The
/// `most_recent_edit` / `busiest_note` maxima are folded over active notes only.
#[derive(Default)]
pub struct UserNoteStats {
    pub notes: u32,
    pub notes_in_trash: u32,
    pub invalid_notes: u32,
    pub most_recent_edit: Option<Timestamp>,
    pub busiest_note: Option<u32>,
}

impl UserNoteStats {
    /// Record one note item (as projected from the notes LSI) into the tally: a
    /// trashed note (one with delete_time) bumps the trash count only; an active
    /// note bumps the active count and updates the modify_time / version_id maxima.
    ///
    /// A corrupt record — one whose summarized fields can't be parsed — is counted
    /// in `invalid_notes` and excluded from the other tallies, rather than
    /// being surfaced as an error. This keeps a single bad note from failing a
    /// whole-table scan; callers reserve hard errors for DynamoDB failures.
    pub fn record_note(&mut self, item: &DynamoDBRecord) {
        if item.contains_key("delete_time") {
            self.notes_in_trash += 1;
            return;
        }
        let (Ok(modify_time), Ok(version_id)) =
            (get_timestamp(item, "modify_time"), get_n_as_u32(item, "version_id"))
        else {
            self.invalid_notes += 1;
            return;
        };
        self.notes += 1;
        self.most_recent_edit = self.most_recent_edit.max(Some(modify_time));
        self.busiest_note = self.busiest_note.max(Some(version_id));
    }

    /// Finalize the tally into a UserDetail for the given user.
    pub fn into_user_detail(self, user_id: String) -> UserDetail {
        UserDetail {
            user_id,
            notes: self.notes,
            notes_in_trash: self.notes_in_trash,
            invalid_notes: self.invalid_notes,
            most_recent_edit: self.most_recent_edit,
            busiest_note: self.busiest_note,
        }
    }
}

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

    let mut stats = UserNoteStats::default();
    let mut exclusive_start_key: Option<DynamoDBRecord> = None;

    // A single pass over the notes-by-modify-time LSI. We read only the
    // projected attributes (never the base table, whose body can be up to
    // 100 KB) and record each note in the tally. No filter and no page limit:
    // we want every note and the fewest round trips.
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
            stats.record_note(&item);
        }

        exclusive_start_key = result.last_evaluated_key;
        if exclusive_start_key.is_none() {
            break;
        }
    }

    let user_detail_json: JsonValue = stats.into_user_detail(user_id).into();

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
    async fn direct_handle_get_user_detail_invalid_notesed() {
        // One good active note and one active note with an unparseable modify_time.
        // The bad note is counted as invalid (not as a note), and the request
        // still succeeds.
        let query_response = r#"{"Items":[
            {"version_id":{"N":"4"},"modify_time":{"S":"2026-03-08T00:00:00.000000000Z"}},
            {"version_id":{"N":"5"},"modify_time":{"S":"not-a-timestamp"}}
        ],"Count":2,"ScannedCount":2}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_user_detail(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        let detail = &json["user_detail"];
        assert_eq!(detail["notes"], 1);
        assert_eq!(detail["invalid_notes"], 1);
        // The invalid note does not contribute to the maxima.
        assert_eq!(detail["most_recent_edit"], "2026-03-08T00:00:00Z");
        assert_eq!(detail["busiest_note"], 4);
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
