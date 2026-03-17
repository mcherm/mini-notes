use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::{Path, State},
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, CurrentTime, http_error};
use crate::models::Note;
use crate::utils::is_valid_id;

/// A struct for the things that are passed in as part of the body when a note is being modified.
#[derive(Debug, Deserialize)]
pub struct EditNoteBody {
    pub title: String,
    pub body: String,
}

/// Logic for handling the edit_note command. This modifies a note that already exists.
#[axum::debug_handler]
pub async fn handle_edit_note(
    State(state): State<AppState>,
    Path(note_id): Path<String>,
    current_time: CurrentTime,
    Json(edit_note_fields): Json<EditNoteBody>,
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    if ! is_valid_id(&note_id) {
        return Err(http_error(404, "note_id has invalid characters"));
    }

    info!(user_id, note_id, table = state.notes_table_name, ?edit_note_fields, "updating note");

    // --- Read the existing record (if any) ---
    let read_result = state.dynamo_client
        .get_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await;
    let read_result = match read_result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };

    let mut updated_note: Note;
    match read_result.item {
        Some(item) => {
            updated_note = match Note::try_from(item) {
                Ok(note) => note,
                Err(err) => {
                    info!(err, "note is invalid in DB");
                    return Err(http_error(500, "note is invalid in DB"));
                }
            };
        }
        None => return Err(http_error(500, "note not found")),
    }

    // --- Apply the changes ---
    updated_note.version_id += 1;
    updated_note.modify_time = current_time.time_string;
    updated_note.title = edit_note_fields.title;
    updated_note.body = edit_note_fields.body;

    // --- Update the record ---
    let result = state.dynamo_client
        .update_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .update_expression("SET title = :t, body = :b, modify_time = :m, version_id = :v")
        .expression_attribute_values(":t", AttributeValue::S(updated_note.title.clone()))
        .expression_attribute_values(":b", AttributeValue::S(updated_note.body.clone()))
        .expression_attribute_values(":m", AttributeValue::S(updated_note.modify_time.clone()))
        .expression_attribute_values(":v", AttributeValue::N(updated_note.version_id.to_string()))
        .send()
        .await;
    if result.is_err() {
        return Err(http_error(404, "no such note or could not update note"));
    }

    let note_json: JsonValue = updated_note.into();
    let body_json = json!({"note": note_json});
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::routing::put;
    use axum::Router;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn test_handle_edit_note_updates_existing_note() {
        use tower::ServiceExt;
        use http_body_util::BodyExt;

        // Canned DynamoDB responses: first GetItem (existing note), then UpdateItem (success)
        let get_item_response = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"3"},"title":{"S":"Old Title"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Old body"}}}"#;
        let update_item_response = r#"{}"#;

        let client = test_dynamo_client(vec![
            replay_ok(get_item_response),
            replay_ok(update_item_response),
        ]);

        let app = Router::new()
            .route("/api/v1/notes/{note_id}", put(handle_edit_note))
            .with_state(test_state(client).0);

        let request = axum::http::Request::builder()
            .method("PUT")
            .uri("/api/v1/notes/ab12cd34ef")
            .header("content-type", "application/json")
            .body(axum::body::Body::from(r#"{"title":"New Title","body":"New body"}"#))
            .unwrap();

        let response = app.oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let body = response.into_body().collect().await.unwrap().to_bytes();
        let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["version_id"], 4);
        assert_eq!(json["note"]["title"], "New Title");
        assert_eq!(json["note"]["create_time"], "2026-03-01T00:00:00.000000000Z");
        assert_eq!(json["note"]["format"], "PlainText");
        assert_eq!(json["note"]["body"], "New body");
    }

    #[tokio::test]
    async fn direct_handle_edit_note_happy_path() {
        let get_item_response = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"3"},"title":{"S":"Old Title"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Old body"}}}"#;
        let update_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(get_item_response),
            replay_ok(update_response),
        ]);

        let result = handle_edit_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Json(EditNoteBody {
                title: "New Title".to_string(),
                body: "New body".to_string(),
            }),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["version_id"], 4);
        assert_eq!(json["note"]["title"], "New Title");
        assert_eq!(json["note"]["create_time"], "2026-03-01T00:00:00.000000000Z");
        assert_eq!(json["note"]["body"], "New body");
    }

    #[tokio::test]
    async fn direct_handle_edit_note_not_found() {
        let get_item_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_edit_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            Json(EditNoteBody {
                title: "New Title".to_string(),
                body: "New body".to_string(),
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(json["error"], "note not found");
    }
}
