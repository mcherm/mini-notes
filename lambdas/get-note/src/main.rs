use aws_sdk_dynamodb::Client as DynamoClient;
use lambda_http::{run, service_fn, Body, Error, Request, RequestExt, Response};
use serde_json::json;
use tracing::info;

async fn handler(client: &DynamoClient, request: Request) -> Result<Response<Body>, Error> {
    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    // Accept note ID from either a path parameter (/notes/{id}) or query string (?id=...)
    let note_id = request
        .path_parameters_ref()
        .and_then(|p| p.first("id"))
        .or_else(|| {
            request
                .query_string_parameters_ref()
                .and_then(|q| q.first("id"))
        })
        .unwrap_or("hello-world");

    info!(note_id, table, "fetching note");

    let result = client
        .get_item()
        .table_name(&table)
        .key(
            "id",
            aws_sdk_dynamodb::types::AttributeValue::S(note_id.to_string()),
        )
        .send()
        .await?;

    let (status, body) = match result.item {
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

    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::Text(body.to_string()))?)
}

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

    run(service_fn(move |request: Request| {
        let client = client.clone();
        async move { handler(&client, request).await }
    }))
    .await
}
