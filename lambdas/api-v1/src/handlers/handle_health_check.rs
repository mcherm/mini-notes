use axum::extract::{Query, State};
use serde_json::json;
use axum::response::Json;
use serde::Deserialize;
use crate::extractors::{http_error, AppState, HandlerOutput};

/// Logic for handling the health command. This just returns a success (or, in advanced
/// mode, verifies access to DynamoDB and returns a success).
#[axum::debug_handler]
pub async fn handle_health_check(
    State(state): State<AppState>,
    Query(query_params): Query<HealthCheckParams>
) -> HandlerOutput {
    let response_body = match query_params.detail.as_deref() {
        // Shallow health check: just return quickly
        None | Some("None") => json!({}),

        // Deep health check: try reading from DynamoDB
        Some("All") => {
            let ddb_output = state.dynamo_client
                .describe_table() // a cheap operation we can perform
                .table_name(&state.notes_table_name)
                .send()
                .await;
            match ddb_output {
                Ok(_) => json!({"dynamodb": "success"}),
                Err(_) => return Err(http_error(500, "dynamodb not available"))
            }
        },

        // Unsupported values
        Some(_) => return Err(http_error(400, "invalid detail for health-check"))
    };
    Ok(Json(response_body))
}

/// Query parameter extractor for health_check.
#[derive(Deserialize)]
pub struct HealthCheckParams {
    pub detail: Option<String>,
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use crate::test_helpers::*;

    fn no_detail_params() -> Query<HealthCheckParams> {
        Query(HealthCheckParams { detail: None })
    }

    fn detail_params(detail: &str) -> Query<HealthCheckParams> {
        Query(HealthCheckParams { detail: Some(detail.to_string()) })
    }

    /// A successful DescribeTable response for the notes table.
    fn describe_table_response() -> &'static str {
        r#"{"Table":{"TableName":"mini-notes-notes-test","ItemCount":123,"TableSizeBytes":45678,"TableStatus":"ACTIVE"}}"#
    }

    /// A DescribeTable failure. ResourceNotFoundException is used because it is not
    /// retried by the SDK, so exactly one replay event is consumed.
    fn describe_table_failure() -> &'static str {
        r#"{"__type":"com.amazonaws.dynamodb.v20120810#ResourceNotFoundException","message":"Requested resource not found"}"#
    }

    #[test]
    fn parse_health_check_params_ignores_extra_params() {
        let uri: axum::http::Uri = "http://example.com/path?foo=hello&bar=42".parse().unwrap();
        let query: Query<HealthCheckParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.detail, None);
    }

    #[test]
    fn parse_health_check_params_parses_detail() {
        let uri: axum::http::Uri = "http://example.com/path?detail=All".parse().unwrap();
        let query: Query<HealthCheckParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.detail, Some("All".to_string()));
    }

    #[tokio::test]
    async fn direct_handle_health_check_shallow_by_default() {
        // An empty replay list asserts that no DynamoDB call is made.
        let client = test_dynamo_client(vec![]);

        let result = handle_health_check(
            test_state(client),
            no_detail_params(),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, serde_json::json!({}));
    }

    #[tokio::test]
    async fn direct_handle_health_check_shallow_explicit_none() {
        let client = test_dynamo_client(vec![]);

        let result = handle_health_check(
            test_state(client),
            detail_params("None"),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, serde_json::json!({}));
    }

    #[tokio::test]
    async fn direct_handle_health_check_deep_happy_path() {
        let client = test_dynamo_client(vec![replay_ok(describe_table_response())]);

        let result = handle_health_check(
            test_state(client),
            detail_params("All"),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["dynamodb"], "success");
    }

    #[tokio::test]
    async fn direct_handle_health_check_deep_dynamodb_unavailable() {
        let client = test_dynamo_client(vec![replay_with_status(400, describe_table_failure())]);

        let result = handle_health_check(
            test_state(client),
            detail_params("All"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(json["error"], "dynamodb not available");
    }

    #[tokio::test]
    async fn direct_handle_health_check_invalid_detail() {
        let client = test_dynamo_client(vec![]);

        let result = handle_health_check(
            test_state(client),
            detail_params("Some"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "invalid detail for health-check");
    }

    #[tokio::test]
    async fn direct_handle_health_check_detail_is_case_sensitive() {
        let client = test_dynamo_client(vec![]);

        let result = handle_health_check(
            test_state(client),
            detail_params("all"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "invalid detail for health-check");
    }
}
