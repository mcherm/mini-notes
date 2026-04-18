//! This file contains code that is shared by multiple handlers.

use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;

use crate::extractors::{HandlerErrOutput, http_error};
use crate::models::User;


pub const MAX_TITLE_LEN: usize = 1000;
pub const MAX_BODY_LEN: usize = 100000;

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
        Err(_) => return Err(http_error(500, "unable to check email availability")),
    };
    if email_check.items.map(|items| !items.is_empty()).unwrap_or(false) {
        return Err(http_error(409, "email already in use"));
    }
    Ok(())
}
