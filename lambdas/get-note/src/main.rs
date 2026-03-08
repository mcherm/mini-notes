use aws_sdk_dynamodb::Client as DynamoClient;
use lambda_http::{run, service_fn, Body, Error, Request, Response};
use serde_json::json;
use tracing::info;

async fn handler(dynamo_client: &DynamoClient, request: Request) -> Result<Response<Body>, Error> {
    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    // Extract note ID from the last path segment: /api/v1/notes/{note_id}
    let path = request.uri().path().to_string();
    let note_id = path
        .split('/')
        .filter(|s| !s.is_empty())
        .last()
        .unwrap_or("hello-world");
    // FIXME: Don't default to "hello-world"; need to fail if this isn't found.
    // FIXME: Don't just take the last component; needs to match "/api/v1/notes/{note_id}" specifically.

    info!(note_id, table, "fetching note");

    let result = dynamo_client
        .get_item()
        .table_name(&table)
        .key(
            "id",
            aws_sdk_dynamodb::types::AttributeValue::S(note_id.to_string()),
        )
        .send()
        .await?;
    // FIXME: Use an import to make "aws_sdk_dynamodb::types::AttributeValue::S" shorter.

    let (status, response_body) = match result.item {
        Some(item) => {
            let note = json!({
                "id":      item.get("id")     .and_then(|v| v.as_s().ok()),
                "title":   item.get("title")  .and_then(|v| v.as_s().ok()),
                "content": item.get("content").and_then(|v| v.as_s().ok()),
            });
            (200u16, json!({ "note": note }))
        }
        None => (404u16, json!({ "error": "note not found", "id": note_id })),
    };
    // FIXME: Fields of the note need to be classified as required and optional. The current
    //   code correctly handles optional fields: if they are missing it populates the JSON
    //   response with a null. But the handling for required fields should be to return an
    //   error instead (probably using "?"). It is quite possible that all of the fields
    //   are required.

    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::Text(response_body.to_string()))?)
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();
    // FIXME: I don't understand what the previous line is doing or how it works

    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;
    let client = DynamoClient::new(&config);

    run(service_fn(move |request: Request| {
        let client = client.clone();
        async move { handler(&client, request).await }
    }))
    .await
    // FIXME: This line does a lot of "move"... is that needed?
}
