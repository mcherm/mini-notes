use std::collections::HashMap;
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use lambda_http::{run, service_fn, Body, Error, Request, Response};
use serde_json::json;
use serde_json::value::Value as JsonValue;
use tracing::info;


/// Helper to create an error response from an error code and a message.
fn http_error(status: u16, message: &str) -> Result<Response<Body>, Error> {
    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::Text(json!({"error": message}).to_string()))?
    )
}

/// Function to validate a note_id; returns true if it is valid.
fn is_valid_note_id(note_id: &str) -> bool {
    note_id.chars().all(|x| x.is_ascii_alphanumeric())
}

/// Convert a DynamoDB note item into JSON. Returns None if any field is the wrong type or
/// any required field is missing.
fn note_from_db(item: &HashMap<String, AttributeValue>) -> Option<JsonValue> {
    let id      = item.get("id")     ?.as_s().ok()?;
    let title   = item.get("title")  ?.as_s().ok()?;
    let content = item.get("content")?.as_s().ok()?;
    Some(json!({"id": id, "title": title, "content": content}))
}


/// This function performs the operation whenever the lambda is invoked. It receives an
/// HTTP request and a handle to the DynamoDB client, and returns a successful HTTP response
/// or an HTTP error.
async fn handler(dynamo_client: &DynamoClient, request: Request) -> Result<Response<Body>, Error> {
    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    // Extract note_id from the path: /api/v1/notes/{note_id}
    let path = request.uri().path();
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let note_id = match path_segments.as_slice() {
        ["api", "v1", "notes", note_id] if is_valid_note_id(note_id) => *note_id,
        ["api", "v1", "notes", _] => return http_error(404, "note_id has invalid characters"),
        _ => return http_error(404, "not found"),
    };

    info!(note_id, table, "fetching note");

    let result = dynamo_client
        .get_item()
        .table_name(&table)
        .key("id", AttributeValue::S(note_id.to_string()))
        .send()
        .await?;

    let item = match result.item {
        Some(item) => item,
        None => return http_error(404, "note not found"),
    };
    let note = match note_from_db(&item) {
        Some(note) => note,
        None => return http_error(500, "note is invalid in DB"),
    };

    Ok(Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Body::Text(json!({"note": note}).to_string()))?)
}

/// Entry point for initializing the lambda's environment, invoked when the lambda is
/// instantiated. Must call run() to perform the main event loop.
#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;
    let client = DynamoClient::new(&config);

    // Kick off main event loop
    run(service_fn(move |request: Request| {
        let client = client.clone();
        async move { handler(&client, request).await }
    }))
    .await
}
