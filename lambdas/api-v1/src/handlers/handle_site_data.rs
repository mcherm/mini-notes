use axum::{
    extract::State,
    response::Json,
};
use serde_json::{json, value::Value as JsonValue};

use crate::extractors::{AppState, HandlerOutput, http_error, UserSession};
use crate::handlers::common;
use crate::models::{SiteData, UserType};


/// Logic for handling the site_data command.
#[axum::debug_handler]
pub async fn handle_site_data(
    State(state): State<AppState>,
    user_session: UserSession,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    let user = common::fetch_user_by_id(&state.dynamo_client, &state.users_table_name, &user_id).await?;

    match user.user_type {
        UserType::Admin => {}
        _ => return Err(http_error(403, "forbidden")),
    }

    let users_stats = describe_table_stats(&state, &state.users_table_name).await?;
    let sessions_stats = describe_table_stats(&state, &state.sessions_table_name).await?;
    let notes_stats = describe_table_stats(&state, &state.notes_table_name).await?;

    let site_data = SiteData {
        user_count: users_stats.0,
        user_size: users_stats.1,
        session_count: sessions_stats.0,
        session_size: sessions_stats.1,
        note_count: notes_stats.0,
        note_size: notes_stats.1,
    };

    let site_data_json: JsonValue = site_data.into();
    let body_json = json!({"site_data": site_data_json});
    Ok(Json(body_json))
}

/// Calls DescribeTable for a single table and returns (item_count, table_size_bytes).
/// DynamoDB refreshes these numbers roughly every six hours, so they are approximate.
async fn describe_table_stats(
    state: &AppState,
    table_name: &str,
) -> Result<(u64, u64), crate::extractors::HandlerErrOutput> {
    let result = state.dynamo_client
        .describe_table()
        .table_name(table_name)
        .send()
        .await;
    let result = match result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };
    let table = match result.table {
        Some(table) => table,
        None => return Err(http_error(500, "describe_table returned no table description")),
    };
    let item_count = table.item_count.unwrap_or(0).max(0) as u64;
    let table_size_bytes = table.table_size_bytes.unwrap_or(0).max(0) as u64;
    Ok((item_count, table_size_bytes))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::test_helpers::*;

    fn admin_user_response() -> &'static str {
        r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"email":{"S":"admin@example.com"},"password_hash":{"S":"hashed_pw"},"user_type":{"S":"Admin"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"}}}"#
    }

    fn earlybird_user_response() -> &'static str {
        r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"email":{"S":"user@example.com"},"password_hash":{"S":"hashed_pw"},"user_type":{"S":"Earlybird"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"}}}"#
    }

    fn describe_table_response(item_count: u64, size: u64, table_name: &str) -> String {
        format!(
            r#"{{"Table":{{"TableName":"{table_name}","ItemCount":{item_count},"TableSizeBytes":{size},"TableStatus":"ACTIVE"}}}}"#
        )
    }

    #[tokio::test]
    async fn direct_handle_site_data_happy_path() {
        let users_desc = describe_table_response(42, 4200, "mini-notes-users-test");
        let sessions_desc = describe_table_response(7, 700, "mini-notes-sessions-test");
        let notes_desc = describe_table_response(123, 45678, "mini-notes-notes-test");
        let client = test_dynamo_client(vec![
            replay_ok(admin_user_response()),
            replay_ok(&users_desc),
            replay_ok(&sessions_desc),
            replay_ok(&notes_desc),
        ]);

        let result = handle_site_data(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["site_data"]["user_count"], 42);
        assert_eq!(json["site_data"]["user_size"], 4200);
        assert_eq!(json["site_data"]["session_count"], 7);
        assert_eq!(json["site_data"]["session_size"], 700);
        assert_eq!(json["site_data"]["note_count"], 123);
        assert_eq!(json["site_data"]["note_size"], 45678);
    }

    #[tokio::test]
    async fn direct_handle_site_data_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_site_data(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn direct_handle_site_data_not_admin() {
        let client = test_dynamo_client(vec![
            replay_ok(earlybird_user_response()),
        ]);

        let result = handle_site_data(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::FORBIDDEN);
        assert_eq!(json["error"], "forbidden");
    }

    #[tokio::test]
    async fn direct_handle_site_data_user_missing() {
        let client = test_dynamo_client(vec![
            replay_ok(r#"{}"#),
        ]);

        let result = handle_site_data(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
    }
}
