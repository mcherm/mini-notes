use aws_sdk_dynamodb::operation::update_item::UpdateItemError;
use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;
use tracing::info;

use crate::extractors::{AppState, CryptographicOps, CurrentTime, HandlerErrOutput, RandomOps, http_error};
use crate::handlers::common::{self, PASSWORD_RESET_TOKEN_MAX_AGE, SERVER_ERROR_MESSAGE};
use crate::models::{PasswordResetToken, User};
use crate::passwords::validate_password;
use crate::utils::constant_time_eq;


/// Stateless brute-force defense for the change-password endpoint: each
/// failed token comparison has a 1-in-N chance of clearing the stored token.
/// Higher = slower burn (more leniency for honest typos), lower = faster
/// destruction of brute-force budget.
const PASSWORD_RESET_TOKEN_BURN_DENOMINATOR: u32 = 32;


/// Body for a password-reset change request.
#[derive(Debug, Deserialize)]
pub struct PwdResetChangeBody {
    pub user_id: String,
    pub token: String,
    pub new_password: String,
}


/// Handler for POST /api/v1/pwd_reset/change_pwd.
///
/// On success, updates the user's password_hash, clears the reset token,
/// invalidates all existing sessions for that user, and returns 204. On any
/// failure of authentication (no such user, no stored token, expired token,
/// token mismatch), returns 401 with the same generic message — so the
/// caller can't distinguish *why* it failed and use that to enumerate users
/// or refine guesses.
///
/// On token mismatch, rolls a 1-in-N die (PASSWORD_RESET_TOKEN_BURN_DENOMINATOR);
/// if it lands, the stored token is cleared. This caps the number of
/// guesses an attacker can make per send: even with millions of attempts,
/// the token will be destroyed long before a successful brute-force.
#[axum::debug_handler]
pub async fn handle_pwd_reset_change(
    State(state): State<AppState>,
    current_time: CurrentTime,
    cryptographic_ops: CryptographicOps,
    RandomOps(gen_u32): RandomOps,
    Json(body): Json<PwdResetChangeBody>,
) -> Result<StatusCode, HandlerErrOutput> {
    info!(user_id = body.user_id, "password reset change attempt");

    if let Err(msg) = validate_password(&body.new_password) {
        return Err(http_error(400, msg));
    }

    // Fetch the user. Do not use common::fetch_user_by_id — that helper
    // returns 500 on no-such-user (because its callers are post-auth),
    // whereas here a missing user is just an unauthenticated bad request.
    let result = state.dynamo_client
        .get_item()
        .table_name(&state.users_table_name)
        .key("user_id", AttributeValue::S(body.user_id.clone()))
        .send()
        .await;
    let item = match result {
        Ok(r) => match r.item {
            Some(i) => i,
            None => return Err(unauthenticated()),
        },
        Err(err) => {
            info!(%err, "users get_item failed");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };
    let user: User = match User::try_from(item) {
        Ok(u) => u,
        Err(err) => {
            info!(err, "user record is invalid in DB");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };

    // No stored token → nothing to verify against. No burn; there's
    // nothing to destroy. Just 401.
    let stored_prt = match user.password_reset_token {
        Some(prt) => prt,
        None => return Err(unauthenticated()),
    };

    // Expired token → cleanup (best-effort), then 401. Cleanup is
    // conditional on the same value we read so we don't clobber a fresher
    // token issued in the gap between read and clear.
    let expires_at = stored_prt.issued_at + PASSWORD_RESET_TOKEN_MAX_AGE;
    if current_time.timestamp >= expires_at {
        info!("token expired; clearing stored token and returning 401");
        clear_token_conditional(&state, &user.user_id, &stored_prt).await;
        return Err(unauthenticated());
    }

    // Constant-time compare of the provided token against the stored one.
    // On mismatch, roll the burn die.
    if !constant_time_eq(&body.token, &stored_prt.token) {
        info!("token mismatch; rolling burn die");
        if gen_u32() % PASSWORD_RESET_TOKEN_BURN_DENOMINATOR == 0 {
            info!("burn die landed; clearing stored token");
            clear_token_conditional(&state, &user.user_id, &stored_prt).await;
        }
        return Err(unauthenticated());
    }

    // Match — generate the new password hash, write it, clear the token.
    // The condition guards against a concurrent successful change (or a
    // concurrent send that rotated the token) racing with this update.
    let new_hash = match (cryptographic_ops.generate_password_hash)(&body.new_password) {
        Ok(h) => h,
        Err(err) => {
            info!(%err, "password hash generation failed");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };

    let stored_value = stored_prt.to_stored();
    let update_result = state.dynamo_client
        .update_item()
        .table_name(&state.users_table_name)
        .key("user_id", AttributeValue::S(user.user_id.clone()))
        .update_expression("SET password_hash = :new_hash REMOVE password_reset_token")
        .condition_expression("password_reset_token = :stored")
        .expression_attribute_values(":new_hash", AttributeValue::S(new_hash))
        .expression_attribute_values(":stored", AttributeValue::S(stored_value))
        .send()
        .await;
    if let Err(sdk_err) = update_result {
        if sdk_err.as_service_error()
            .map(|e| matches!(e, UpdateItemError::ConditionalCheckFailedException(_)))
            .unwrap_or(false)
        {
            info!("conditional update failed (token rotated mid-request); 401");
            return Err(unauthenticated());
        }
        info!(%sdk_err, "password update_item failed");
        return Err(http_error(500, SERVER_ERROR_MESSAGE));
    }

    // Invalidate any other live sessions for this user. Per design: a
    // successful password reset terminates every existing session.
    common::delete_all_sessions_for_user(
        &state.dynamo_client,
        &state.sessions_table_name,
        &user.user_id,
    ).await?;

    info!(user_id = user.user_id, "password reset successful");
    Ok(StatusCode::NO_CONTENT)
}


/// All authentication failures of this endpoint share the same response
/// shape, so callers can't distinguish among "no such user", "no stored
/// token", "expired", "wrong token", or "concurrent token rotation".
fn unauthenticated() -> HandlerErrOutput {
    http_error(401, "Password reset link is invalid or expired.")
}

/// Best-effort: clear the user's password_reset_token only if it still
/// matches the value we just read. Failures are swallowed (logged), since
/// the caller has already decided to fail the request anyway and the
/// stored token will eventually expire on its own.
async fn clear_token_conditional(
    state: &AppState,
    user_id: &str,
    stored_prt: &PasswordResetToken,
) {
    let stored_value = stored_prt.to_stored();
    let result = state.dynamo_client
        .update_item()
        .table_name(&state.users_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .update_expression("REMOVE password_reset_token")
        .condition_expression("password_reset_token = :stored")
        .expression_attribute_values(":stored", AttributeValue::S(stored_value))
        .send()
        .await;
    if let Err(err) = result {
        info!(%err, "failed to clear stored token (non-fatal)");
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::passwords;
    use crate::test_helpers::*;

    // ---- Stubs ----

    /// Random source where 0 % 32 == 0, so the burn die "lands" (token cleared).
    fn random_zero() -> u32 { 0 }

    /// Random source where 1 % 32 != 0, so the burn die does NOT land.
    fn random_one() -> u32 { 1 }

    fn stub_generate_hash(_password: &str) -> Result<String, passwords::HashFailedError> {
        Ok("new_stub_hash".to_string())
    }
    fn stub_verify(_password: &str, _hash: &str) -> Result<bool, passwords::HashFailedError> {
        Ok(true)
    }
    fn test_crypto_ops() -> CryptographicOps {
        CryptographicOps {
            generate_password_hash: stub_generate_hash,
            verify_password: stub_verify,
        }
    }

    // ---- Canned get_item responses ----

    /// User with a recent (non-expired) reset token. Token issued at
    /// 11:00:00; tests use 12:00:00 as "now"; max age is 3 hours, so this
    /// is well within the validity window.
    const USER_WITH_RECENT_TOKEN: &str = r#"{"Item":{
        "user_id":{"S":"Xq3_mK8~pL"},
        "email":{"S":"alice@example.com"},
        "password_hash":{"S":"old_hash"},
        "user_type":{"S":"Earlybird"},
        "create_time":{"S":"2026-03-01T00:00:00.000000000Z"},
        "password_reset_token":{"S":"2026-05-03T11:00:00Z|GoodTok"}
    }}"#;

    /// User whose token is well past the 3-hour max age.
    const USER_WITH_EXPIRED_TOKEN: &str = r#"{"Item":{
        "user_id":{"S":"Xq3_mK8~pL"},
        "email":{"S":"alice@example.com"},
        "password_hash":{"S":"old_hash"},
        "user_type":{"S":"Earlybird"},
        "create_time":{"S":"2026-03-01T00:00:00.000000000Z"},
        "password_reset_token":{"S":"2026-05-01T00:00:00Z|GoodTok"}
    }}"#;

    /// User without any reset token (e.g., never requested one).
    const USER_WITHOUT_TOKEN: &str = r#"{"Item":{
        "user_id":{"S":"Xq3_mK8~pL"},
        "email":{"S":"alice@example.com"},
        "password_hash":{"S":"old_hash"},
        "user_type":{"S":"Earlybird"},
        "create_time":{"S":"2026-03-01T00:00:00.000000000Z"}
    }}"#;

    /// get_item with no Item field — i.e., user_id not found.
    const NO_SUCH_USER: &str = r#"{}"#;

    fn body_for(token: &str, password: &str) -> Json<PwdResetChangeBody> {
        Json(PwdResetChangeBody {
            user_id: "Xq3_mK8~pL".to_string(),
            token: token.to_string(),
            new_password: password.to_string(),
        })
    }

    // ---- Tests ----

    #[tokio::test]
    async fn empty_password_returns_400_with_no_io() {
        // Validation rejects before any DynamoDB IO.
        let dynamo = test_dynamo_client(vec![]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("anything", ""),
        ).await;
        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn user_not_found_returns_401() {
        let dynamo = test_dynamo_client(vec![replay_ok(NO_SUCH_USER)]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("anything", "newpass"),
        ).await;
        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "Password reset link is invalid or expired.");
    }

    #[tokio::test]
    async fn no_stored_token_returns_401() {
        let dynamo = test_dynamo_client(vec![replay_ok(USER_WITHOUT_TOKEN)]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("anything", "newpass"),
        ).await;
        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "Password reset link is invalid or expired.");
    }

    #[tokio::test]
    async fn expired_token_clears_and_returns_401() {
        // Expects: get_item, then the conditional REMOVE cleanup.
        let cleanup_ok = r#"{}"#;
        let dynamo = test_dynamo_client(vec![
            replay_ok(USER_WITH_EXPIRED_TOKEN),
            replay_ok(cleanup_ok),
        ]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("GoodTok", "newpass"),
        ).await;
        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_token_burn_does_not_land_returns_401() {
        // gen_u32 returns 1 → 1 % 32 != 0, no cleanup write.
        let dynamo = test_dynamo_client(vec![replay_ok(USER_WITH_RECENT_TOKEN)]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("WrongTok", "newpass"),
        ).await;
        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn wrong_token_burn_lands_clears_and_returns_401() {
        // gen_u32 returns 0 → 0 % 32 == 0, conditional REMOVE happens.
        let cleanup_ok = r#"{}"#;
        let dynamo = test_dynamo_client(vec![
            replay_ok(USER_WITH_RECENT_TOKEN),
            replay_ok(cleanup_ok),
        ]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_zero),
            body_for("WrongTok", "newpass"),
        ).await;
        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn happy_path_updates_password_clears_token_and_invalidates_sessions() {
        // Expects:
        //   1. get_item returns the user with a fresh token.
        //   2. update_item (SET new hash, REMOVE token) succeeds.
        //   3. scan sessions returns one session for this user.
        //   4. delete that session succeeds.
        let update_ok = r#"{}"#;
        let scan_one_session =
            r#"{"Items":[{"session_id":{"S":"sess-1"}}],"Count":1,"ScannedCount":1}"#;
        let delete_session_ok = r#"{}"#;
        let dynamo = test_dynamo_client(vec![
            replay_ok(USER_WITH_RECENT_TOKEN),
            replay_ok(update_ok),
            replay_ok(scan_one_session),
            replay_ok(delete_session_ok),
        ]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("GoodTok", "newpass"),
        ).await;
        assert_eq!(result.unwrap(), StatusCode::NO_CONTENT);
    }

    #[tokio::test]
    async fn conditional_update_failed_returns_401() {
        // Token verifies correctly, but the conditional update fails (e.g.,
        // a concurrent send rotated the stored token between our read and
        // our write). Should map to 401, not 500.
        let dynamo = test_dynamo_client(vec![
            replay_ok(USER_WITH_RECENT_TOKEN),
            replay_conditional_check_failed(),
        ]);
        let result = handle_pwd_reset_change(
            test_state(dynamo),
            current_time_stub("2026-05-03T12:00:00Z"),
            test_crypto_ops(),
            RandomOps(random_one),
            body_for("GoodTok", "newpass"),
        ).await;
        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "Password reset link is invalid or expired.");
    }
}
