//! This file contains code that is shared by multiple handlers.

use std::time::Duration;

use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use tracing::info;

use crate::extractors::{HandlerErrOutput, http_error};
use crate::models::{User, get_s};


pub const MAX_TITLE_LEN: usize = 1000;
pub const MAX_BODY_LEN: usize = 100000;

/// User-facing message for any 500 response.
pub const SERVER_ERROR_MESSAGE: &str = "Server error.";

/// How long a password-reset token remains valid after it was issued.
/// Lives here because it's used both by the change handler (for the
/// expiration check) and by the send handler (rendered into the email
/// body so the user knows roughly when the link will stop working).
pub const PASSWORD_RESET_TOKEN_MAX_AGE: Duration = Duration::from_hours(3);

/// Verifies that a title and body are of a valid size. Returns an error response if
/// they are not.
/// 
/// Limits: title may be up to 1,000 bytes of UTF-8. Body may be up to 100,000 bytes
/// of UTF-8.
pub fn verify_size(title: &str, body: &str) -> Result<(), String> {
    if title.len() > MAX_TITLE_LEN {
        return Err(format!("Title too long, exceeds {MAX_TITLE_LEN} bytes in UFF-8"))
    }
    if body.len() > MAX_BODY_LEN {
        return Err(format!("Body too long, exceeds {MAX_BODY_LEN} bytes in UFF-8"))
    }
    Ok(())
}

/// Looks up a user by user_id in DynamoDB and returns the parsed User record.
/// Returns a 500 error if the user is missing or the record is malformed, since
/// callers are always behind a valid session and a missing user indicates an
/// internal inconsistency.
pub async fn fetch_user_by_id(dynamo_client: &DynamoClient, users_table_name: &str, user_id: &str) -> Result<User, HandlerErrOutput> {
    let result = dynamo_client
        .get_item()
        .table_name(users_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .send()
        .await;
    let result = match result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };
    let item = match result.item {
        Some(item) => item,
        None => return Err(http_error(500, "user for session not found")),
    };
    match User::try_from(item) {
        Ok(user) => Ok(user),
        Err(err) => {
            tracing::info!(err, "user is invalid in DB");
            Err(http_error(500, "user is invalid in DB"))
        }
    }
}

/// Deletes every session belonging to the given user. The sessions table has
/// session_id as its only key, so this scans with a filter on user_id and then
/// deletes the matching session_ids one-by-one. Per-row delete errors are
/// swallowed (best-effort cleanup); errors from the scan itself are returned.
///
/// DESIGN NOTE: As long as the number of sessions isn't too big, doing a scan
/// is probably just fine. But if the number of sessions ever gets big, we'll
/// need to create an index (LSI or GSI) to support lookup of sessions by
/// user_id.
pub async fn delete_all_sessions_for_user(
    dynamo_client: &DynamoClient,
    sessions_table_name: &str,
    user_id: &str,
) -> Result<(), HandlerErrOutput> {
    let mut exclusive_start_key = None;
    loop {
        let mut scan_builder = dynamo_client
            .scan()
            .table_name(sessions_table_name)
            .filter_expression("user_id = :uid")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
            .projection_expression("session_id");
        if let Some(start_key) = exclusive_start_key {
            scan_builder = scan_builder.set_exclusive_start_key(Some(start_key));
        }

        let scan_result = match scan_builder.send().await {
            Ok(response) => response,
            Err(err) => {
                info!(%err, "sessions scan failed");
                return Err(http_error(500, SERVER_ERROR_MESSAGE));
            }
        };

        let items = scan_result.items.unwrap_or_default();
        for item in &items {
            let session_id = match get_s(item, "session_id") {
                Ok(id) => id,
                Err(_) => continue,
            };
            let _ = dynamo_client
                .delete_item()
                .table_name(sessions_table_name)
                .key("session_id", AttributeValue::S(session_id))
                .send()
                .await;
        }

        if scan_result.last_evaluated_key.is_none() {
            break;
        }
        exclusive_start_key = scan_result.last_evaluated_key;
    }
    Ok(())
}

/// Normalizes an email address into its canonical storage form. Email is
/// treated as case-insensitive, so this lowercases it, and surrounding
/// whitespace is insignificant, so it is trimmed. Apply this to any email
/// read from a request before using it for lookups, storage, or comparison.
pub fn normalize_email(email: &str) -> String {
    email.trim().to_lowercase()
}

/// Queries the users-by-email GSI to check whether the given email address is
/// already associated with an existing user. Returns Ok if the email is available,
/// or a 409 error if it is already in use.
pub async fn check_email_available(dynamo_client: &DynamoClient, users_table_name: &str, email: &str) -> Result<(), HandlerErrOutput> {
    let email_check = dynamo_client
        .query()
        .table_name(users_table_name)
        .index_name("users-by-email")
        .key_condition_expression("email = :email")
        .expression_attribute_values(":email", AttributeValue::S(email.to_string()))
        .limit(1)
        .send()
        .await;
    let email_check = match email_check {
        Ok(response) => response,
        Err(err) => {
            info!(%err, "users-by-email query failed");
            return Err(http_error(500, SERVER_ERROR_MESSAGE));
        }
    };
    if email_check.items.map(|items| !items.is_empty()).unwrap_or(false) {
        return Err(http_error(409, "email already in use"));
    }
    Ok(())
}
