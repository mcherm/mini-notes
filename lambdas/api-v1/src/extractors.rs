use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_sesv2::Client as SesClient;
use axum::{
    extract::FromRequestParts,
    response::Json,
    http::{StatusCode, request::Parts},
};
use serde_json::json;
use time::UtcDateTime;

use crate::passwords;
use crate::utils::{generate_id, random_u32, effective_expire_time, SESSION_REFRESH_THRESHOLD_HOURS};
use crate::models::{Session, Timestamp};

pub type HandlerErrOutput = (StatusCode, Json<serde_json::Value>);
pub type HandlerOutput = Result<Json<serde_json::Value>, HandlerErrOutput>;

/// Helper to create the contents of the Err to return from an error response from an error code and a message.
pub fn http_error<T: TryInto<StatusCode>>(status: T, message: &str) -> HandlerErrOutput {
    (
        status.try_into().unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({"error": message}))
    )
}

/// Common information shared by every call. Must be Clone since each thread will get a copy.
#[derive(Clone)]
pub struct AppState {
    pub dynamo_client: DynamoClient,
    pub ses_client: SesClient,
    pub notes_table_name: String,
    pub users_table_name: String,
    pub sessions_table_name: String,
    pub frontend_base_url: String,
}


/// Extractor for getting the user session from a cookie.
///
/// Beyond reading, this extractor has two side effects on the sessions table: it deletes a
/// session that has expired (returning no session), and it lazily refreshes `last_used` /
/// `expire_time` on a still-valid session whose `last_used` has gone stale.
pub struct UserSession(pub Option<Session>);

impl FromRequestParts<AppState> for UserSession {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let Some(session_id) = parts.headers
            .get_all(axum::http::header::COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .flat_map(|s| s.split(';'))
            .map(|s| s.trim())
            .find_map(|cookie| {
                cookie.strip_prefix("session_id=").map(|v| v.to_string())
            })
        else {
            return Ok(UserSession(None))
        };
        let result = state.dynamo_client
            .get_item()
            .table_name(&state.sessions_table_name)
            .key("session_id", AttributeValue::S(session_id))
            .send()
            .await;
        let mut session: Session = match result {
            Ok(output) => match output.item {
                Some(item) => match Session::try_from(item) {
                    Ok(session) => session,
                    Err(_) => return Ok(UserSession(None)),
                },
                None => return Ok(UserSession(None)),
            },
            Err(_) => return Ok(UserSession(None)),
        };
        let now = Timestamp::from_date_time(UtcDateTime::now());

        // Enforce expiry explicitly: a single check covers both the idle window and the
        // absolute cap, since expire_time folds them together. DynamoDB TTL is only a
        // cleanup backstop (and lags by up to ~48h), so it is never relied on here. Delete
        // the expired row on the way out so it doesn't linger.
        if session.expire_time <= now {
            let _ = state.dynamo_client
                .delete_item()
                .table_name(&state.sessions_table_name)
                .key("session_id", AttributeValue::S(session.session_id.clone()))
                .send()
                .await;
            return Ok(UserSession(None));
        }

        // Lazily refresh the sliding window. To keep write traffic to at most once per
        // session per day, only write when last_used is more than the refresh threshold
        // stale. Simultaneous requests may each write, which is harmless and simpler than
        // guarding against it.
        let last_used_age_secs = now.unix_timestamp() - session.last_used.unix_timestamp();
        if last_used_age_secs > (SESSION_REFRESH_THRESHOLD_HOURS as i64) * 3600 {
            session.last_used = now;
            session.expire_time = effective_expire_time(session.last_used, session.create_time);
            let _ = state.dynamo_client
                .put_item()
                .table_name(&state.sessions_table_name)
                .set_item(Some(session.to_item()))
                .send()
                .await;
        }

        Ok(UserSession(Some(session)))
    }
}

/// Extractor for getting the time from the system clock.
pub struct CurrentTime {
    pub timestamp: Timestamp,
}

/// Make CurrentTime into an extractor that can be used by handlers if declared as an argument.
impl FromRequestParts<AppState> for CurrentTime {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(_parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(CurrentTime {
            timestamp: Timestamp::from_date_time(UtcDateTime::now()),
        })
    }
}

/// Extractor for generating new IDs. In production, axum resolves this using
/// generate_id(); in tests, callers construct it directly with any function.
pub struct IdGenerator(pub fn() -> String);

impl FromRequestParts<AppState> for IdGenerator {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(_parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(IdGenerator(generate_id))
    }
}

/// Extractor for sources of randomness that aren't tied to ID generation
/// (currently just the burn-die roll in handle_pwd_reset_change). In
/// production this delegates to `random_u32`; tests pass a stub that
/// returns a fixed value to make burn behavior deterministic.
pub struct RandomOps(pub fn() -> u32);

impl FromRequestParts<AppState> for RandomOps {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(_parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(RandomOps(random_u32))
    }
}

/// Extractor for accessing the cryptographic functions. In production, axum uses
/// the functions from the passwords module; in tests callers can place in stubs.
pub struct CryptographicOps {
    pub generate_password_hash: fn(&str) -> Result<String, passwords::HashFailedError>,
    pub verify_password: fn(&str, &str) -> Result<bool, passwords::HashFailedError>,
}

impl FromRequestParts<AppState> for CryptographicOps {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(_parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(CryptographicOps {
            generate_password_hash: passwords::generate_password_hash,
            verify_password: passwords::verify_password,
        })
    }
}
