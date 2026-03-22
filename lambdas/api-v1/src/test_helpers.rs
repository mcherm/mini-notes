use aws_sdk_dynamodb::Client as DynamoClient;
use axum::extract::State;
use aws_smithy_http_client::test_util::{ReplayEvent, StaticReplayClient};
use aws_smithy_types::body::SdkBody;
use time::{UtcDateTime, format_description::well_known::Iso8601};

use crate::extractors::{AppState, CurrentTime, UserSession};
use crate::models::{Session};


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
        expire_time: "2026-03-10T00:00:00.000000000Z".to_string(),
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

/// Create a stub CurrentTime object from a string. Used for tests.
pub fn current_time_stub(s: &str) -> CurrentTime {
    CurrentTime {
        date_time: UtcDateTime::parse(s, &Iso8601::DEFAULT).unwrap(),
        time_string: s.to_string(),
    }
}
