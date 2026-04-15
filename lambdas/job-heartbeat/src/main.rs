use lambda_runtime::{Error, LambdaEvent, service_fn};
use serde_json::Value;

async fn handler(event: LambdaEvent<Value>) -> Result<Value, Error> {
    tracing::info!("heartbeat job ran; payload={:?}", event.payload);
    let tables = common::TableNames::load();
    let _client = common::dynamo_client().await;
    tracing::info!("resolved notes table: {}", tables.notes);
    Ok(serde_json::json!({ "status": "ok" }))
}

#[tokio::main]
async fn main() -> Result<(), Error> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();
    lambda_runtime::run(service_fn(handler)).await
}
