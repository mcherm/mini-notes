mod models;
mod utils;
mod extractors;
mod passwords;
mod handlers;
#[cfg(test)]
mod test_helpers;

use aws_sdk_dynamodb::Client as DynamoClient;
use axum::{
    Router,
    http::{Method, header},
    routing::{get, put, post, delete},
};
use tower_http::cors::CorsLayer;

use extractors::AppState;
use handlers::{
    handle_get_notes::handle_get_notes,
    handle_new_note::handle_new_note,
    handle_get_note::handle_get_note,
    handle_edit_note::handle_edit_note,
    handle_delete_note::handle_delete_note,
    handle_search_notes::handle_search_notes,
    handle_user_login::handle_user_login,
};

/// Entry point for initializing the lambda's environment, invoked when the lambda is
/// instantiated. Must call run() to perform the main event loop.
#[tokio::main]
async fn main() -> Result<(), lambda_http::Error> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let config = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .load()
        .await;
    let client = DynamoClient::new(&config);

    // Read configuration from environment
    let stage = std::env::var("STAGE")
        .expect("STAGE env var must be set");
    let allowed_origin = std::env::var("ALLOWED_ORIGIN")
        .expect("ALLOWED_ORIGIN env var must be set");

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::PUT, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_origin([allowed_origin.parse().expect("Invalid ALLOWED_ORIGIN")])
        .allow_credentials(true);

    let state = AppState {
        dynamo_client: client,
        notes_table_name: format!("mini-notes-notes-{stage}"),
        users_table_name: format!("mini-notes-users-{stage}"),
        sessions_table_name: format!("mini-notes-sessions-{stage}"),
    };
    let app = Router::new()
        .route("/api/v1/notes", get(handle_get_notes))
        .route("/api/v1/notes", post(handle_new_note))
        .route("/api/v1/notes/{note_id}", get(handle_get_note))
        .route("/api/v1/notes/{note_id}", put(handle_edit_note))
        .route("/api/v1/notes/{note_id}", delete(handle_delete_note))
        .route("/api/v1/note_search", get(handle_search_notes))
        .route("/api/v1/user_login", post(handle_user_login))
        .with_state(state)
        .layer(cors);
    lambda_http::run(app).await
}
