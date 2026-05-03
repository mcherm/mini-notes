use std::time::Duration;

use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_sesv2::Client as SesClient;
use aws_sdk_sesv2::types::{Body, Content, Destination, EmailContent, Message};
use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;
use tracing::{info, warn};

use crate::extractors::{AppState, CurrentTime, HandlerErrOutput, http_error};
use crate::handlers::common::PASSWORD_RESET_TOKEN_MAX_AGE;
use crate::models::{PasswordResetToken, User};
use crate::utils::generate_id_of_length;


/// The address used in the From: header of password-reset emails. Hardcoded
/// because it's tied to the verified SES domain identity (see
/// aws/configure-ses.sh) and does not vary per stage. If a stage-specific
/// from-address is ever needed, replace with a `match common::stage()`
/// (compare frontend_base_url in main.rs).
const FROM_EMAIL: &str = "noreply@mini-notes.com";

/// Minimum gap between successive password-reset emails for the same user.
/// While a stored token is younger than this, the send endpoint refuses to
/// issue a new one (still returning the same indistinguishable response).
const PASSWORD_RESET_RESEND_COOLDOWN: Duration = Duration::from_secs(60);

/// Length of the random portion of a password-reset token, in characters of
/// the mini-notes ID alphabet (~6 bits each, so 32 chars ≈ 192 bits).
const PASSWORD_RESET_TOKEN_LENGTH: usize = 32;


/// Body for a password-reset send request.
#[derive(Debug, Deserialize)]
pub struct PwdResetSendBody {
    pub email: String,
}


/// Handler for POST /api/v1/pwd_reset/send.
///
/// Always returns 204 on the design's indistinguishable paths (malformed
/// email, no such user, cooldown active, SES failure). DB I/O errors
/// surface as 500 — matching how the login handler treats DynamoDB
/// errors — but those don't depend on which user the caller is asking
/// about, so they don't leak account existence.
#[axum::debug_handler]
pub async fn handle_pwd_reset_send(
    State(state): State<AppState>,
    current_time: CurrentTime,
    Json(body): Json<PwdResetSendBody>,
) -> Result<StatusCode, HandlerErrOutput> {
    info!(email = body.email, "password reset send attempt");

    if !email_looks_valid(&body.email) {
        info!("email failed validity check; returning 204 anyway");
        return Ok(StatusCode::NO_CONTENT);
    }

    // Look up the user by email via the GSI.
    let query_result = state.dynamo_client
        .query()
        .table_name(&state.users_table_name)
        .index_name("users-by-email")
        .key_condition_expression("email = :email")
        .expression_attribute_values(":email", AttributeValue::S(body.email.clone()))
        .limit(1)
        .send()
        .await;
    let query_result = match query_result {
        Ok(r) => r,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };
    let Some(item) = query_result.items
        .and_then(|mut items| if items.is_empty() { None } else { Some(items.remove(0)) })
    else {
        info!("no user with that email; returning 204 anyway");
        return Ok(StatusCode::NO_CONTENT);
    };
    let user: User = match User::try_from(item) {
        Ok(u) => u,
        Err(err) => {
            info!(err, "user record is invalid in DB");
            return Err(http_error(500, "user record is invalid in DB"));
        }
    };

    // Cooldown: if there's an existing token younger than the cooldown,
    // skip generating + sending a new one. (We don't care here whether the
    // token is also past its MAX_AGE — that's the change-password
    // handler's concern.) This exists to prevent (or at least delay)
    // attacks that spam a user rapidly with large number of emails.
    if let Some(ref existing) = user.password_reset_token {
        if existing.issued_at + PASSWORD_RESET_RESEND_COOLDOWN > current_time.timestamp {
            info!(
                user_id = user.user_id,
                "existing reset token is still within cooldown; not resending"
            );
            return Ok(StatusCode::NO_CONTENT);
        }
    }

    // Generate, store, send.
    let token = generate_id_of_length(PASSWORD_RESET_TOKEN_LENGTH);
    let stored = PasswordResetToken {
        issued_at: current_time.timestamp,
        token: token.clone(),
    }.to_stored();

    let update_result = state.dynamo_client
        .update_item()
        .table_name(&state.users_table_name)
        .key("user_id", AttributeValue::S(user.user_id.clone()))
        .update_expression("SET password_reset_token = :token")
        .expression_attribute_values(":token", AttributeValue::S(stored))
        .send()
        .await;
    if let Err(err) = update_result {
        return Err(http_error(500, &err.to_string()));
    }

    // Both user_id and token are drawn from the mini-notes ID alphabet
    // (0-9 A-Z a-z _ ~), all of which are URL-safe per RFC 3986, so no
    // percent-encoding is needed.
    let link = format!(
        "{}/reset-password.html?user_id={}&token={}",
        state.frontend_base_url,
        user.user_id,
        token,
    );

    if let Err(err) = send_reset_email(&state.ses_client, FROM_EMAIL, &body.email, &link).await {
        // Per design: still return 204 on SES failure.
        warn!(error = err, "SES send_email failed");
    }

    Ok(StatusCode::NO_CONTENT)
}


/// Permissive check that a string looks like an email address. The rule is
/// "[non-empty]@[non-empty].[non-empty]" — any string that wouldn't even
/// reach SES's address parser is rejected, but no attempt is made at full
/// RFC-5322 compliance.
fn email_looks_valid(email: &str) -> bool {
    let mut at_split = email.split('@');
    let local = match at_split.next() {
        Some(s) => s,
        None => return false,
    };
    let domain = match at_split.next() {
        Some(s) => s,
        None => return false,
    };
    if at_split.next().is_some() {
        return false; // more than one '@'
    }
    if local.is_empty() || domain.is_empty() {
        return false;
    }
    let mut domain_split = domain.rsplitn(2, '.');
    let tld = domain_split.next().unwrap_or("");
    let subdomain = domain_split.next().unwrap_or("");
    !tld.is_empty() && !subdomain.is_empty()
}

/// Build a plain-text password-reset email and hand it to SES v2 SendEmail.
/// The error string is for logging only — callers translate any failure
/// into the same indistinguishable response anyway.
async fn send_reset_email(
    client: &SesClient,
    from: &str,
    to: &str,
    link: &str,
) -> Result<(), String> {
    let subject = Content::builder()
        .data("Reset your Mini-Notes password")
        .charset("UTF-8")
        .build()
        .map_err(|e| format!("email subject build failed: {e}"))?;
    // Render the validity window from the constant. Rounds down to whole
    // hours; the "approximately" wording covers both that rounding and the
    // gap between sending the email and the user reading it.
    let max_age_hours = PASSWORD_RESET_TOKEN_MAX_AGE.as_secs() / 3600;
    let hour_word = if max_age_hours == 1 { "hour" } else { "hours" };
    let body_text = format!(
        "A password reset was requested for your Mini-Notes account.\n\
         \n\
         To set a new password, follow this link:\n\
         \n\
         {link}\n\
         \n\
         This link will expire approximately {max_age_hours} {hour_word} \
         after this email was sent. If you did not request a password \
         reset, you can ignore this email.\n"
    );
    let body_content = Content::builder()
        .data(body_text)
        .charset("UTF-8")
        .build()
        .map_err(|e| format!("body build failed: {e}"))?;
    let message = Message::builder()
        .subject(subject)
        .body(Body::builder().text(body_content).build())
        .build();
    let content = EmailContent::builder().simple(message).build();
    let destination = Destination::builder()
        .to_addresses(to)
        .build();
    client.send_email()
        .from_email_address(from)
        .destination(destination)
        .content(content)
        .send()
        .await
        .map_err(|e| format!("SES send_email failed: {e}"))?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    /// SES SendEmail returns a small JSON body with the assigned MessageId.
    const SES_OK_RESPONSE: &str = r#"{"MessageId":"msg-test-1"}"#;

    /// User record with no existing reset token.
    const USER_NO_TOKEN: &str = r#"{"Items":[{
        "user_id":{"S":"Xq3_mK8~pL"},
        "email":{"S":"alice@example.com"},
        "password_hash":{"S":"hashed_pw"},
        "user_type":{"S":"Earlybird"},
        "create_time":{"S":"2026-03-01T00:00:00.000000000Z"}
    }],"Count":1,"ScannedCount":1}"#;

    #[test]
    fn email_looks_valid_accepts_typical() {
        assert!(email_looks_valid("user@example.com"));
        assert!(email_looks_valid("a@b.c"));
        assert!(email_looks_valid("user.name+tag@sub.example.co.uk"));
    }

    #[test]
    fn email_looks_valid_rejects_obvious_garbage() {
        assert!(!email_looks_valid(""));
        assert!(!email_looks_valid("nope"));
        assert!(!email_looks_valid("@example.com"));
        assert!(!email_looks_valid("user@"));
        assert!(!email_looks_valid("user@example"));
        assert!(!email_looks_valid("user@.com"));
        assert!(!email_looks_valid("user@example."));
        assert!(!email_looks_valid("two@@example.com"));
        assert!(!email_looks_valid("a@b@c.d"));
    }

    #[tokio::test]
    async fn invalid_email_returns_204_with_no_io() {
        // No DynamoDB or SES interaction expected.
        let dynamo = test_dynamo_client(vec![]);
        let result = handle_pwd_reset_send(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            Json(PwdResetSendBody { email: "not-an-email".to_string() }),
        ).await;
        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn no_user_with_email_returns_204() {
        // GSI query returns no rows; nothing else should happen.
        let empty_query = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let dynamo = test_dynamo_client(vec![replay_ok(empty_query)]);
        let result = handle_pwd_reset_send(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            Json(PwdResetSendBody { email: "nobody@example.com".to_string() }),
        ).await;
        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn cooldown_active_returns_204_without_send() {
        // Existing token issued 30s before "now"; cooldown is 60s, so we
        // should bail before any update or send. Only the GSI query is expected.
        let user_within_cooldown = r#"{"Items":[{
            "user_id":{"S":"Xq3_mK8~pL"},
            "email":{"S":"alice@example.com"},
            "password_hash":{"S":"hashed_pw"},
            "user_type":{"S":"Earlybird"},
            "create_time":{"S":"2026-03-01T00:00:00.000000000Z"},
            "password_reset_token":{"S":"2026-05-03T11:59:30Z|sometoken"}
        }],"Count":1,"ScannedCount":1}"#;
        let dynamo = test_dynamo_client(vec![replay_ok(user_within_cooldown)]);
        let result = handle_pwd_reset_send(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            Json(PwdResetSendBody { email: "alice@example.com".to_string() }),
        ).await;
        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn happy_path_writes_token_and_sends() {
        let update_response = r#"{}"#;
        let dynamo = test_dynamo_client(vec![
            replay_ok(USER_NO_TOKEN),
            replay_ok(update_response),
        ]);
        let ses = test_ses_client(vec![replay_ok(SES_OK_RESPONSE)]);

        let result = handle_pwd_reset_send(
            test_state_with_ses(dynamo, ses),
            current_time_stub("2026-05-03T12:00:00Z"),
            Json(PwdResetSendBody { email: "alice@example.com".to_string() }),
        ).await;
        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn ses_failure_still_returns_204() {
        let update_response = r#"{}"#;
        let ses_error_body = r#"{"__type":"MessageRejected","message":"address not verified"}"#;
        let dynamo = test_dynamo_client(vec![
            replay_ok(USER_NO_TOKEN),
            replay_ok(update_response),
        ]);
        let ses = test_ses_client(vec![replay_with_status(400, ses_error_body)]);

        let result = handle_pwd_reset_send(
            test_state_with_ses(dynamo, ses),
            current_time_stub("2026-05-03T12:00:00Z"),
            Json(PwdResetSendBody { email: "alice@example.com".to_string() }),
        ).await;
        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }
}
