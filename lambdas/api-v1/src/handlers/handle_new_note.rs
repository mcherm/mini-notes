use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    extract::State,
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, CurrentTime, IdGenerator, http_error};
use crate::models::{Note, NoteFormat};

/// A struct for the things that are passed in as part of the body when a new note is created.
#[derive(Debug, Deserialize)]
pub struct NewNoteBody {
    pub title: String,
    pub body: String,
    pub format: NoteFormat,
}

/// Logic for handling the new_note command.
#[axum::debug_handler]
pub async fn handle_new_note(
    State(state): State<AppState>,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    Json(new_note_fields): Json<NewNoteBody>,
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    let note_id = generate_id();

    info!(user_id, note_id, table = state.notes_table_name, ?new_note_fields, "creating note");

    let note: Note = Note {
        user_id: user_id.to_string(),
        note_id,
        version_id: 0,
        title: new_note_fields.title,
        create_time: current_time.time_string.clone(),
        modify_time: current_time.time_string,
        format: new_note_fields.format,
        body: new_note_fields.body,
    };

    let result = state.dynamo_client
        .put_item()
        .table_name(&state.notes_table_name)
        .item("user_id", AttributeValue::S(note.user_id.clone()))
        .item("note_id", AttributeValue::S(note.note_id.clone()))
        .item("version_id", AttributeValue::N(note.version_id.to_string()))
        .item("title", AttributeValue::S(note.title.clone()))
        .item("create_time", AttributeValue::S(note.create_time.clone()))
        .item("modify_time", AttributeValue::S(note.modify_time.clone()))
        .item("format", AttributeValue::S(note.format.to_string()))
        .item("body", AttributeValue::S(note.body.clone()))
        .send()
        .await;
    if result.is_err() {
        return Err(http_error(500, "unable to create new note"));
    }

    let note_json: JsonValue = note.into();
    let body_json = json!({"note": note_json});
    Ok(Json(body_json))
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_new_note_happy_path() {
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(put_response)]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "TESTID1234");
        assert_eq!(json["note"]["version_id"], 0);
        assert_eq!(json["note"]["title"], "Test Title");
        assert_eq!(json["note"]["create_time"], "2026-03-15T12:00:00.000000000Z");
        assert_eq!(json["note"]["modify_time"], "2026-03-15T12:00:00.000000000Z");
        assert_eq!(json["note"]["format"], "PlainText");
        assert_eq!(json["note"]["body"], "Test body");
    }
}
