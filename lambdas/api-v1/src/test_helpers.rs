use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_sesv2::Client as SesClient;
use axum::extract::State;
use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient};
use aws_smithy_types::body::SdkBody;

use crate::extractors::{AppState, CurrentTime, UserSession};
use crate::models::{Session, Timestamp};


/// Helper: build a DynamoClient backed by canned HTTP responses.
pub fn test_dynamo_client(events: Vec<ReplayEvent>) -> DynamoClient {
    let http_client = StaticReplayClient::new(events);
    let config = aws_sdk_dynamodb::Config::builder()
        .http_client(http_client)
        .region(aws_sdk_dynamodb::config::Region::new("us-east-1"))
        .credentials_provider(aws_credential_types::Credentials::new(
            "test", "test", None, None, "test"
        ))
        .behavior_version_latest()
        .build();
    DynamoClient::from_conf(config)
}

/// Helper: build an SES client backed by canned HTTP responses. Pass the
/// events you expect SES to receive (in order); pass `vec![]` if the test
/// shouldn't trigger any SES calls.
pub fn test_ses_client(events: Vec<ReplayEvent>) -> SesClient {
    let http_client = StaticReplayClient::new(events);
    let config = aws_sdk_sesv2::Config::builder()
        .http_client(http_client)
        .region(aws_sdk_sesv2::config::Region::new("us-east-1"))
        .credentials_provider(aws_credential_types::Credentials::new(
            "test", "test", None, None, "test"
        ))
        .behavior_version_latest()
        .build();
    SesClient::from_conf(config)
}

/// Build a test AppState with a DynamoDB client and an SES client that
/// expects no calls. Most handler tests use this — the SES client is just
/// there to satisfy `AppState`.
pub fn test_state(client: DynamoClient) -> State<AppState> {
    test_state_with_ses(client, test_ses_client(vec![]))
}

/// Build a test AppState with explicitly-provided DynamoDB and SES clients.
/// Use this when a test needs to assert that SES was (or wasn't) called.
pub fn test_state_with_ses(dynamo_client: DynamoClient, ses_client: SesClient) -> State<AppState> {
    State(AppState {
        dynamo_client,
        ses_client,
        notes_table_name: "mini-notes-notes-test".to_string(),
        users_table_name: "mini-notes-users-test".to_string(),
        sessions_table_name: "mini-notes-sessions-test".to_string(),
        frontend_base_url: "https://test.mini-notes-test".to_string(),
    })
}

/// Returns a stub UserSession with the given user_id.
pub fn test_user_session(s: &str) -> UserSession {
    UserSession(Some(Session{
        session_id: "test-session-id".to_string(),
        user_id: s.to_string(),
        create_time: Timestamp::from_str("2026-02-08T00:00:00Z").unwrap(),
        last_used: Timestamp::from_str("2026-03-09T00:00:00Z").unwrap(),
        expire_time: Timestamp::from_str("2026-03-10T00:00:00Z").unwrap(),
    }))
}

/// Returns a stub UserSession which is not logged in.
pub fn test_no_user_session() -> UserSession {
    UserSession(None)
}


pub fn replay_ok(response_body: &str) -> ReplayEvent {
    replay_with_status(200, response_body)
}

/// Helper: build a ReplayEvent that returns the given HTTP status and body.
/// Useful for simulating service errors in tests (e.g. an SES MessageRejected).
pub fn replay_with_status(status: u16, response_body: &str) -> ReplayEvent {
    ReplayEvent::new(
        axum::http::Request::builder().body(SdkBody::empty()).unwrap(),
        axum::http::Response::builder()
            .status(status)
            .body(SdkBody::from(response_body.to_string()))
            .unwrap(),
    )
}

/// Helper: build a ReplayEvent that returns a DynamoDB ConditionalCheckFailedException.
pub fn replay_conditional_check_failed() -> ReplayEvent {
    let body = r#"{"__type":"com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException","message":"The conditional request failed"}"#;
    ReplayEvent::new(
        axum::http::Request::builder().body(SdkBody::empty()).unwrap(),
        axum::http::Response::builder()
            .status(400)
            .body(SdkBody::from(body.to_string()))
            .unwrap(),
    )
}

/// Helper: build a ReplayEvent that returns a ConditionalCheckFailedException with an Item
/// (as returned when ReturnValuesOnConditionCheckFailure is AllOld and the item exists).
pub fn replay_conditional_check_failed_with_item() -> ReplayEvent {
    let body = r#"{"__type":"com.amazonaws.dynamodb.v20120810#ConditionalCheckFailedException","message":"The conditional request failed","Item":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"}}}"#;
    ReplayEvent::new(
        axum::http::Request::builder().body(SdkBody::empty()).unwrap(),
        axum::http::Response::builder()
            .status(400)
            .body(SdkBody::from(body.to_string()))
            .unwrap(),
    )
}

/// Create a stub CurrentTime object from a string. Used for tests.
pub fn current_time_stub(s: &str) -> CurrentTime {
    CurrentTime {
        timestamp: Timestamp::from_str(s).unwrap(),
    }
}
