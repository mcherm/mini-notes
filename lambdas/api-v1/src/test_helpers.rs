use aws_sdk_dynamodb::Client as DynamoClient;
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

pub fn test_state(client: DynamoClient) -> State<AppState> {
    State(AppState {
        dynamo_client: client,
        notes_table_name: "mini-notes-notes-test".to_string(),
        users_table_name: "mini-notes-users-test".to_string(),
        sessions_table_name: "mini-notes-sessions-test".to_string(),
    })
}

/// Returns a stub UserSession with the given user_id.
pub fn test_user_session(s: &str) -> UserSession {
    UserSession(Some(Session{
        session_id: "test-session-id".to_string(),
        user_id: s.to_string(),
        expire_time: Timestamp::from_str("2026-03-10T00:00:00Z").unwrap(),
    }))
}

/// Returns a stub UserSession which is not logged in.
pub fn test_no_user_session() -> UserSession {
    UserSession(None)
}


pub fn replay_ok(response_body: &str) -> ReplayEvent {
    ReplayEvent::new(
        axum::http::Request::builder().body(SdkBody::empty()).unwrap(),
        axum::http::Response::builder()
            .status(200)
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
