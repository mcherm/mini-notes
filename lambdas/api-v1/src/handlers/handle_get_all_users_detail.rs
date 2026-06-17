use std::collections::HashMap;

use axum::{
    extract::State,
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::handlers::common;
use crate::handlers::handle_get_user_detail::UserNoteStats;
use crate::models::{DynamoDBRecord, FullUserInfo, User, UserType, get_s};

/// One user's record plus the note tally we accumulate for it during the notes scan.
struct UserAccum {
    user: User,
    stats: UserNoteStats,
}

/// Logic for handling the admin users_detail command. Returns a User + UserDetail
/// for every user on the site (sorted by active note count, descending), a count
/// of "orphan" notes whose user_id has no matching user record, and a count of
/// user records that couldn't be parsed.
///
/// Admin only. Scans the whole users table and the whole notes table, so it is
/// O(users + notes); acceptable at the current scale. A user record that can't be
/// parsed is tallied in `invalid_user_count` and skipped; a note that can't be
/// parsed is tallied as invalid in its owner's UserDetail (or as an orphan if it
/// can't be attributed to a user). Such single-record data errors don't fail the
/// request — only DynamoDB errors are fatal.
#[axum::debug_handler]
pub async fn handle_get_all_users_detail(
    State(state): State<AppState>,
    user_session: UserSession,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };

    let caller = common::fetch_user_by_id(&state.dynamo_client, &state.users_table_name, &session.user_id).await?;
    match caller.user_type {
        UserType::Admin => {}
        _ => return Err(http_error(403, "forbidden")),
    }

    info!(table = state.users_table_name, "computing all users detail");

    // Pass A: scan the users table, seeding the map with every known user so the
    // notes scan can attribute (or orphan) each note inline. A user record that
    // can't be parsed is counted and skipped rather than failing the request.
    let mut accums: HashMap<String, UserAccum> = HashMap::new();
    let mut invalid_user_count: u32 = 0;
    let mut exclusive_start_key: Option<DynamoDBRecord> = None;
    loop {
        let result = state.dynamo_client
            .scan()
            .table_name(&state.users_table_name)
            .set_exclusive_start_key(exclusive_start_key)
            .send()
            .await;
        let result = match result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &err.to_string())),
        };
        for item in result.items.unwrap_or_default() {
            let Ok(user) = User::try_from(item) else {
                invalid_user_count += 1;
                continue;
            };
            accums.insert(user.user_id.clone(), UserAccum { user, stats: UserNoteStats::default() });
        }
        exclusive_start_key = result.last_evaluated_key;
        if exclusive_start_key.is_none() {
            break;
        }
    }

    // Pass B: scan the notes-by-modify-time LSI (small projection, never the base
    // table) and fold each note into its user's tally. A note whose user_id is not
    // a known user is an orphan and is only counted.
    let mut orphan_note_count: u32 = 0;
    let mut exclusive_start_key: Option<DynamoDBRecord> = None;
    loop {
        let result = state.dynamo_client
            .scan()
            .table_name(&state.notes_table_name)
            .index_name("notes-by-modify-time")
            .projection_expression("user_id, delete_time, modify_time, version_id")
            .set_exclusive_start_key(exclusive_start_key)
            .send()
            .await;
        let result = match result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &err.to_string())),
        };
        for item in result.items.unwrap_or_default() {
            // A note whose user_id can't be read can't be attributed to a user;
            // like an unknown user_id, count it as an orphan rather than failing.
            let Ok(user_id) = get_s(&item, "user_id") else {
                orphan_note_count += 1;
                continue;
            };
            match accums.get_mut(&user_id) {
                Some(accum) => accum.stats.record_note(&item),
                None => orphan_note_count += 1,
            }
        }
        exclusive_start_key = result.last_evaluated_key;
        if exclusive_start_key.is_none() {
            break;
        }
    }

    // Assemble the response, sorted by active note count (heaviest users first).
    let mut users: Vec<FullUserInfo> = accums
        .into_values()
        .map(|UserAccum { user, stats }| FullUserInfo {
            user_detail: stats.into_user_detail(user.user_id.clone()),
            user,
        })
        .collect();
    users.sort_by(|a, b| b.user_detail.notes.cmp(&a.user_detail.notes));

    let users_json: JsonValue = users.into_iter().map(JsonValue::from).collect();
    let body_json = json!({
        "users": users_json,
        "orphan_note_count": orphan_note_count,
        "invalid_user_count": invalid_user_count,
    });
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::test_helpers::*;

    const ADMIN_ID: &str = "Xq3_mK8~pL";

    /// A users-table item (also valid as the body of a get_item "Item").
    fn user_item(user_id: &str, user_type: &str) -> String {
        format!(
            r#"{{"user_id":{{"S":"{user_id}"}},"email":{{"S":"{user_id}@example.com"}},"password_hash":{{"S":"hashed_pw"}},"user_type":{{"S":"{user_type}"}},"create_time":{{"S":"2026-03-01T00:00:00.000000000Z"}}}}"#
        )
    }

    fn get_item_response(user_id: &str, user_type: &str) -> String {
        format!(r#"{{"Item":{}}}"#, user_item(user_id, user_type))
    }

    /// Wraps pre-rendered item JSON strings into a scan response body.
    fn scan_response(items: &[String]) -> String {
        let joined = items.join(",");
        let count = items.len();
        format!(r#"{{"Items":[{joined}],"Count":{count},"ScannedCount":{count}}}"#)
    }

    /// A notes-LSI scan item: active unless `delete_time` is Some.
    fn note_item(user_id: &str, version_id: u32, modify_time: &str, delete_time: Option<&str>) -> String {
        let delete = match delete_time {
            Some(dt) => format!(r#","delete_time":{{"S":"{dt}"}}"#),
            None => String::new(),
        };
        format!(
            r#"{{"user_id":{{"S":"{user_id}"}},"version_id":{{"N":"{version_id}"}},"modify_time":{{"S":"{modify_time}"}}{delete}}}"#
        )
    }

    #[tokio::test]
    async fn direct_happy_path_sorted_with_user_id() {
        let users = scan_response(&[
            user_item(ADMIN_ID, "Admin"),
            user_item("user2_id00", "Earlybird"),
        ]);
        let notes = scan_response(&[
            // user2 has the most active notes -> sorts first. Its trashed note has
            // the largest version_id / latest modify_time, which must be excluded.
            note_item("user2_id00", 3, "2026-03-10T00:00:00.000000000Z", None),
            note_item("user2_id00", 7, "2026-03-12T00:00:00.000000000Z", None),
            note_item("user2_id00", 99, "2026-03-30T00:00:00.000000000Z", Some("2026-03-31T00:00:00.000000000Z")),
            note_item(ADMIN_ID, 1, "2026-03-05T00:00:00.000000000Z", None),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users),
            replay_ok(&notes),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["orphan_note_count"], 0);
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 2);

        // Sorted by active note count descending: user2 (2) before admin (1).
        assert_eq!(users[0]["user"]["user_id"], "user2_id00");
        assert_eq!(users[0]["user_detail"]["notes"], 2);
        assert_eq!(users[0]["user_detail"]["notes_in_trash"], 1);
        assert_eq!(users[0]["user_detail"]["most_recent_edit"], "2026-03-12T00:00:00Z");
        assert_eq!(users[0]["user_detail"]["busiest_note"], 7);

        // user_id and email are exposed in the admin view; password_hash is not.
        assert_eq!(users[1]["user"]["user_id"], ADMIN_ID);
        assert_eq!(users[1]["user_detail"]["notes"], 1);
        assert_eq!(users[1]["user"]["email"], "Xq3_mK8~pL@example.com");
        assert!(users[1]["user"].get("password_hash").is_none());
    }

    #[tokio::test]
    async fn direct_multi_page_scans() {
        let users_page1 = format!(
            r#"{{"Items":[{}],"Count":1,"ScannedCount":1,"LastEvaluatedKey":{{"user_id":{{"S":"user2_id00"}}}}}}"#,
            user_item("user2_id00", "Earlybird")
        );
        let users_page2 = scan_response(&[user_item(ADMIN_ID, "Admin")]);
        let notes_page1 = format!(
            r#"{{"Items":[{}],"Count":1,"ScannedCount":1,"LastEvaluatedKey":{{"user_id":{{"S":"user2_id00"}},"note_id":{{"S":"n1"}},"modify_time":{{"S":"2026-03-01T00:00:00.000000000Z"}}}}}}"#,
            note_item("user2_id00", 3, "2026-03-01T00:00:00.000000000Z", None)
        );
        let notes_page2 = scan_response(&[
            note_item("user2_id00", 8, "2026-03-25T00:00:00.000000000Z", None),
            note_item("user2_id00", 50, "2026-03-28T00:00:00.000000000Z", Some("2026-03-29T00:00:00.000000000Z")),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users_page1),
            replay_ok(&users_page2),
            replay_ok(&notes_page1),
            replay_ok(&notes_page2),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 2);
        // user2's notes span both notes pages; tallies and maxima carry across.
        assert_eq!(users[0]["user"]["user_id"], "user2_id00");
        assert_eq!(users[0]["user_detail"]["notes"], 2);
        assert_eq!(users[0]["user_detail"]["notes_in_trash"], 1);
        assert_eq!(users[0]["user_detail"]["most_recent_edit"], "2026-03-25T00:00:00Z");
        assert_eq!(users[0]["user_detail"]["busiest_note"], 8);
        assert_eq!(users[1]["user"]["user_id"], ADMIN_ID);
        assert_eq!(users[1]["user_detail"]["notes"], 0);
    }

    #[tokio::test]
    async fn direct_orphan_notes_counted_not_listed() {
        let users = scan_response(&[user_item(ADMIN_ID, "Admin")]);
        let notes = scan_response(&[
            note_item(ADMIN_ID, 1, "2026-03-05T00:00:00.000000000Z", None),
            note_item("ghost00000", 2, "2026-03-06T00:00:00.000000000Z", None),
            note_item("ghost00000", 1, "2026-03-07T00:00:00.000000000Z", Some("2026-03-08T00:00:00.000000000Z")),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users),
            replay_ok(&notes),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        // Both ghost notes (one active, one trashed) belong to no user.
        assert_eq!(json["orphan_note_count"], 2);
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["user"]["user_id"], ADMIN_ID);
        assert_eq!(users[0]["user_detail"]["notes"], 1);
    }

    #[tokio::test]
    async fn direct_user_with_no_notes() {
        let users = scan_response(&[
            user_item(ADMIN_ID, "Admin"),
            user_item("user2_id00", "Earlybird"),
        ]);
        let notes = scan_response(&[
            note_item(ADMIN_ID, 4, "2026-03-08T00:00:00.000000000Z", None),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users),
            replay_ok(&notes),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 2);
        // admin has one note and sorts first; user2 has none -> null maxima.
        assert_eq!(users[1]["user"]["user_id"], "user2_id00");
        assert_eq!(users[1]["user_detail"]["notes"], 0);
        assert_eq!(users[1]["user_detail"]["notes_in_trash"], 0);
        assert!(users[1]["user_detail"]["most_recent_edit"].is_null());
        assert!(users[1]["user_detail"]["busiest_note"].is_null());
    }

    #[tokio::test]
    async fn direct_invalid_notesed_per_user() {
        let users = scan_response(&[user_item(ADMIN_ID, "Admin")]);
        let notes = scan_response(&[
            note_item(ADMIN_ID, 4, "2026-03-08T00:00:00.000000000Z", None),
            // A corrupt note for the admin: unparseable modify_time.
            r#"{"user_id":{"S":"Xq3_mK8~pL"},"version_id":{"N":"5"},"modify_time":{"S":"not-a-timestamp"}}"#.to_string(),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users),
            replay_ok(&notes),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["orphan_note_count"], 0);
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 1);
        // The bad note is invalid, not counted as a note.
        assert_eq!(users[0]["user_detail"]["notes"], 1);
        assert_eq!(users[0]["user_detail"]["invalid_notes"], 1);
    }

    #[tokio::test]
    async fn direct_invalid_user_counted_not_listed() {
        // The admin is valid; a second user record has an unparseable create_time.
        let users = scan_response(&[
            user_item(ADMIN_ID, "Admin"),
            r#"{"user_id":{"S":"baduser000"},"email":{"S":"bad@example.com"},"password_hash":{"S":"h"},"user_type":{"S":"Earlybird"},"create_time":{"S":"not-a-date"}}"#.to_string(),
        ]);
        let notes = scan_response(&[
            note_item(ADMIN_ID, 1, "2026-03-05T00:00:00.000000000Z", None),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users),
            replay_ok(&notes),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["invalid_user_count"], 1);
        // Only the valid admin user is listed.
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["user"]["user_id"], ADMIN_ID);
    }

    #[tokio::test]
    async fn direct_note_with_unreadable_user_id_counts_as_orphan() {
        let users = scan_response(&[user_item(ADMIN_ID, "Admin")]);
        // The second note's user_id is the wrong type (a number), so it can't be
        // attributed; it's counted as an orphan and doesn't fail the request.
        let notes = scan_response(&[
            note_item(ADMIN_ID, 1, "2026-03-05T00:00:00.000000000Z", None),
            r#"{"user_id":{"N":"123"},"version_id":{"N":"2"},"modify_time":{"S":"2026-03-06T00:00:00.000000000Z"}}"#.to_string(),
        ]);
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Admin")),
            replay_ok(&users),
            replay_ok(&notes),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["orphan_note_count"], 1);
        let users = json["users"].as_array().unwrap();
        assert_eq!(users.len(), 1);
        assert_eq!(users[0]["user_detail"]["notes"], 1);
    }

    #[tokio::test]
    async fn direct_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn direct_not_admin() {
        let client = test_dynamo_client(vec![
            replay_ok(&get_item_response(ADMIN_ID, "Earlybird")),
        ]);

        let result = handle_get_all_users_detail(
            test_state(client),
            test_user_session(ADMIN_ID),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "forbidden");
    }
}
