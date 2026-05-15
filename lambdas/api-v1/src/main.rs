mod models;
mod utils;
mod extractors;
mod passwords;
mod handlers;
pub mod diff;
#[cfg(test)]
mod test_helpers;

use axum::{
    Router,
    http::{HeaderValue, Method, header},
    routing::{get, put, post, delete},
};
use tower_http::cors::CorsLayer;
use tower_http::set_header::SetResponseHeaderLayer;

use extractors::AppState;
use handlers::{
    handle_get_notes::handle_get_notes,
    handle_new_note::handle_new_note,
    handle_get_note::handle_get_note,
    handle_edit_note::handle_edit_note,
    handle_delete_note::handle_delete_note,
    handle_get_deleted_notes::handle_get_deleted_notes,
    handle_recover_note::handle_recover_note,
    handle_destroy_deleted_note::handle_destroy_deleted_note,
    handle_search_notes::handle_search_notes,
    handle_user_login::handle_user_login,
    handle_user_logout::handle_user_logout,
    handle_user_create::handle_user_create,
    handle_get_user::handle_get_user,
    handle_edit_user::handle_edit_user,
    handle_delete_user::handle_delete_user,
    handle_export_notes::handle_export_notes,
    handle_import_notes::handle_import_notes,
    handle_site_data::handle_site_data,
    handle_pwd_reset_send::handle_pwd_reset_send,
    handle_pwd_reset_change::handle_pwd_reset_change,
};

/// Entry point for initializing the lambda's environment, invoked when the lambda is
/// instantiated. Must call run() to perform the main event loop.
#[tokio::main]
async fn main() -> Result<(), lambda_http::Error> {
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .json()
        .init();

    let dynamo_client = common::dynamo_client().await;
    let ses_client = common::ses_client().await;

    let tables = common::TableNames::load();
    // The frontend domain is determined entirely by the deployment stage. Used
    // both as the CORS allowed origin and as the base URL embedded in
    // outgoing emails.
    let frontend_base_url = match common::stage().as_str() {
        "prod" => "https://mini-notes.com".to_string(),
        "dev" => "https://dev.mini-notes.com".to_string(),
        other => panic!("STAGE env var must be 'prod' or 'dev', got '{other}'"),
    };

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::PUT, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_origin([frontend_base_url.parse().expect("Invalid frontend_base_url")])
        .allow_credentials(true);

    let state = AppState {
        dynamo_client,
        ses_client,
        notes_table_name: tables.notes,
        users_table_name: tables.users,
        sessions_table_name: tables.sessions,
        frontend_base_url,
    };
    let app = Router::new()
        .route("/api/v1/notes", get(handle_get_notes))
        .route("/api/v1/notes", post(handle_new_note))
        .route("/api/v1/notes/{note_id}", get(handle_get_note))
        .route("/api/v1/notes/{note_id}", put(handle_edit_note))
        .route("/api/v1/notes/{note_id}", delete(handle_delete_note))
        .route("/api/v1/deleted_notes", get(handle_get_deleted_notes))
        .route("/api/v1/recover_note/{note_id}", post(handle_recover_note))
        .route("/api/v1/deleted_notes/{note_id}", delete(handle_destroy_deleted_note))
        .route("/api/v1/note_export", get(handle_export_notes))
        .route("/api/v1/note_import", post(handle_import_notes))
        .route("/api/v1/note_search", get(handle_search_notes))
        .route("/api/v1/user", get(handle_get_user))
        .route("/api/v1/user", delete(handle_delete_user))
        .route("/api/v1/user", post(handle_edit_user))
        .route("/api/v1/user_login", post(handle_user_login))
        .route("/api/v1/user_logout", post(handle_user_logout))
        .route("/api/v1/user_create", post(handle_user_create))
        .route("/api/v1/pwd_reset/send", post(handle_pwd_reset_send))
        .route("/api/v1/pwd_reset/change_pwd", post(handle_pwd_reset_change))
        .route("/api/v1/admin/site_data", get(handle_site_data))
        .with_state(state)
        .layer(cors)
        // Every API response declares Cache-Control: no-store. The data is
        // user-mutable (notes can change at any moment from another tab or
        // device), so any HTTP caching is a correctness hazard, not just a
        // performance concern. Browsers' heuristic caching of GETs in the
        // absence of this header is what we're guarding against.
        .layer(SetResponseHeaderLayer::overriding(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ));
    lambda_http::run(app).await
}
