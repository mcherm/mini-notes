use std::io::{Cursor, Read};

use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    body::Bytes,
    extract::State,
    response::Json,
};
use serde_json::{json, Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, CurrentTime, IdGenerator, http_error, UserSession};
use crate::models::{Note, NoteFormat, parse_note_format};


/// Result of an import operation, tracking how many notes were created vs updated.
struct ImportResult {
    notes_created: u32,
    notes_updated: u32,
}

impl ImportResult {
    fn new() -> Self {
        ImportResult { notes_created: 0, notes_updated: 0 }
    }
}

impl From<ImportResult> for JsonValue {
    fn from(result: ImportResult) -> Self {
        json!({
            "notes_created": result.notes_created,
            "notes_updated": result.notes_updated,
        })
    }
}

/// Zip files start with these magic bytes ("PK\x03\x04").
const ZIP_MAGIC_BYTES: &[u8] = &[0x50, 0x4B, 0x03, 0x04];

/// Write a single note to DynamoDB using put_item.
async fn put_note(state: &AppState, note: Note) -> Result<(), String> {
    state.dynamo_client
        .put_item()
        .table_name(&state.notes_table_name)
        .item("user_id", AttributeValue::S(note.user_id))
        .item("note_id", AttributeValue::S(note.note_id))
        .item("version_id", AttributeValue::N(note.version_id.to_string()))
        .item("title", AttributeValue::S(note.title))
        .item("create_time", AttributeValue::S(note.create_time))
        .item("modify_time", AttributeValue::S(note.modify_time))
        .item("format", AttributeValue::S(note.format.to_string()))
        .item("body", AttributeValue::S(note.body))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    Ok(())
}

/// Look up an existing note by user_id + note_id.
/// Returns (version_id, create_time) if the note exists.
async fn get_existing_note_info(
    state: &AppState,
    user_id: &str,
    note_id: &str,
) -> Result<Option<(u32, String)>, String> {
    let result = state.dynamo_client
        .get_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .projection_expression("version_id, create_time")
        .send()
        .await
        .map_err(|err| err.to_string())?;

    match result.item {
        None => Ok(None),
        Some(item) => {
            let version_id: u32 = item.get("version_id")
                .ok_or("missing version_id")?
                .as_n()
                .map_err(|_| "version_id is not a number")?
                .parse()
                .map_err(|_| "version_id is not a valid u32")?;
            let create_time = item.get("create_time")
                .ok_or("missing create_time")?
                .as_s()
                .map_err(|_| "create_time is not a string")?
                .to_string();
            Ok(Some((version_id, create_time)))
        }
    }
}

/// Import notes from a JSON body (same format as export).
async fn import_from_json(
    state: &AppState,
    user_id: &str,
    time_string: &str,
    generate_id: fn() -> String,
    body: &[u8],
) -> Result<ImportResult, String> {
    let parsed: JsonValue = serde_json::from_slice(body)
        .map_err(|err| format!("invalid JSON: {err}"))?;

    let notes_array = parsed.get("notes")
        .and_then(|v| v.as_array())
        .ok_or("JSON must contain a \"notes\" array")?;

    let mut result = ImportResult::new();

    for note_json in notes_array {
        let title = note_json.get("title")
            .and_then(|v| v.as_str())
            .ok_or("each note must have a \"title\" string")?;
        let body_text = note_json.get("body")
            .and_then(|v| v.as_str())
            .ok_or("each note must have a \"body\" string")?;
        let format = match note_json.get("format").and_then(|v| v.as_str()) {
            Some(f) => parse_note_format(f).map_err(|e| format!("invalid format: {e}"))?,
            None => NoteFormat::PlainText,
        };

        let provided_note_id = note_json.get("note_id").and_then(|v| v.as_str());
        let provided_create_time = note_json.get("create_time").and_then(|v| v.as_str());

        // DESIGN NOTE: The code is currently ignoring any value of version_id that was
        // provided by the imported JSON. That might or might not be the behavior we want
        // in the long run.

        let provided_modify_time = note_json.get("modify_time").and_then(|v| v.as_str());

        // Determine note_id, version_id, and create_time from existing note (if any)
        let (note_id, version_id, existing_create_time, is_update) = match provided_note_id {
            Some(note_id) => {
                match get_existing_note_info(state, user_id, note_id).await? {
                    Some((current_version, create_time)) =>
                        (note_id.to_string(), current_version + 1, Some(create_time), true),
                    None =>
                        (note_id.to_string(), 0, None, false),
                }
            }
            None => (generate_id(), 0, None, false),
        };

        // create_time priority: JSON value > existing note's value > now
        let create_time = provided_create_time
            .map(|s| s.to_string())
            .or(existing_create_time)
            .unwrap_or_else(|| time_string.to_string());

        // modify_time: use the provided value, or current time if one isn't provided
        let modify_time = provided_modify_time.unwrap_or(time_string).to_string();

        let note = Note {
            user_id: user_id.to_string(),
            note_id,
            version_id,
            title: title.to_string(),
            create_time,
            modify_time,
            format,
            body: body_text.to_string(),
        };
        put_note(state, note).await?;
        if is_update {
            result.notes_updated += 1;
        } else {
            result.notes_created += 1;
        }
    }

    Ok(result)
}

/// Extract (title, body) pairs from a zip file of text files. Synchronous.
fn extract_notes_from_zip(body: &[u8]) -> Result<Vec<(String, String)>, String> {
    let reader = Cursor::new(body);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|err| format!("invalid zip file: {err}"))?;

    let mut entries: Vec<(String, String)> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|err| format!("zip read error: {err}"))?;

        let name = file.name().to_string();
        if !name.ends_with(".txt") {
            // DESIGN NOTE: any file not ending in .txt is ignored (without producing an error)
            continue;
        }

        let title = name.strip_suffix(".txt").unwrap_or(&name).to_string();

        let mut contents = String::new();
        file.read_to_string(&mut contents)
            .map_err(|err| format!("error reading '{name}' from zip: {err}"))?;

        entries.push((title, contents));
    }

    Ok(entries)
}

/// Import notes from a zip file of text files.
async fn import_from_zip(
    state: &AppState,
    user_id: &str,
    time_string: &str,
    generate_id: fn() -> String,
    body: &[u8],
) -> Result<ImportResult, String> {
    let entries = extract_notes_from_zip(body)?;

    let mut result = ImportResult::new();
    for (title, contents) in entries {
        let note = Note {
            user_id: user_id.to_string(),
            note_id: generate_id(),
            version_id: 0,
            title,
            create_time: time_string.to_string(),
            modify_time: time_string.to_string(),
            format: NoteFormat::PlainText,
            body: contents,
        };
        put_note(state, note).await?;
        result.notes_created += 1;
    }

    Ok(result)
}


/// Handler for importing notes from a file upload.
#[axum::debug_handler]
pub async fn handle_import_notes(
    State(state): State<AppState>,
    user_session: UserSession,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    body: Bytes,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, body_len = body.len(), table = state.notes_table_name, "importing notes");

    let import_result = if body.starts_with(ZIP_MAGIC_BYTES) {
        import_from_zip(&state, &user_id, &current_time.time_string, generate_id, &body)
            .await
            .map_err(|err| http_error(500, &err))?
    } else {
        import_from_json(&state, &user_id, &current_time.time_string, generate_id, &body)
            .await
            .map_err(|err| http_error(400, &err))?
    };

    info!(
        user_id,
        notes_created = import_result.notes_created,
        notes_updated = import_result.notes_updated,
        "import complete"
    );

    Ok(Json(import_result.into()))
}


#[cfg(test)]
mod tests {
    use std::io::Write;

    use super::*;
    use crate::test_helpers::*;
    use axum::http::StatusCode;
    use zip::write::{SimpleFileOptions, ZipWriter};

    fn fake_id() -> String { "TESTIMP001".to_string() }

    fn make_zip(files: &[(&str, &str)]) -> Bytes {
        let buf = Cursor::new(Vec::new());
        let mut zip = ZipWriter::new(buf);
        for (name, content) in files {
            zip.start_file(*name, SimpleFileOptions::default()).unwrap();
            zip.write_all(content.as_bytes()).unwrap();
        }
        let bytes = zip.finish().unwrap().into_inner();
        Bytes::from(bytes)
    }

    const PUT_OK: &str = r#"{}"#;

    #[tokio::test]
    async fn test_import_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_import_notes(
            test_state(client),
            test_no_user_session(),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from_static(b"{}"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn test_import_invalid_content() {
        let client = test_dynamo_client(vec![]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from_static(b"this is not json or zip"),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_import_json_creates_new_notes() {
        // One put_item per note
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
            replay_ok(PUT_OK),
        ]);

        let body = serde_json::to_vec(&json!({
            "notes": [
                {"title": "Note One", "body": "Body one"},
                {"title": "Note Two", "body": "Body two", "format": "PlainText"},
            ]
        })).unwrap();

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 2);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_json_updates_existing() {
        // get_item returns existing note, then put_item for update
        let get_response = r#"{"Item":{"user_id":{"S":"user1"},"note_id":{"S":"existing1"},"version_id":{"N":"3"},"create_time":{"S":"2026-01-01T00:00:00.000000000Z"}}}"#;
        let client = test_dynamo_client(vec![
            replay_ok(get_response),
            replay_ok(PUT_OK),
        ]);

        let body = serde_json::to_vec(&json!({
            "notes": [
                {"note_id": "existing1", "title": "Updated Title", "body": "Updated body"},
            ]
        })).unwrap();

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 0);
        assert_eq!(json["notes_updated"], 1);
    }

    #[tokio::test]
    async fn test_import_json_new_with_note_id() {
        // get_item returns empty (no existing note), then put_item for create
        let get_empty = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_ok(get_empty),
            replay_ok(PUT_OK),
        ]);

        let body = serde_json::to_vec(&json!({
            "notes": [
                {"note_id": "newid12345", "title": "Brand New", "body": "New body"},
            ]
        })).unwrap();

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_zip_creates_notes() {
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
            replay_ok(PUT_OK),
        ]);

        let body = make_zip(&[
            ("First Note.txt", "Hello world"),
            ("Second Note.txt", "Goodbye world"),
        ]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 2);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_zip_ignores_non_txt() {
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
        ]);

        let body = make_zip(&[
            ("Keep This.txt", "content"),
            ("skip_this.json", "{\"not\": \"imported\"}"),
            ("image.png", "fake png data"),
        ]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
        assert_eq!(json["notes_updated"], 0);
    }
}
