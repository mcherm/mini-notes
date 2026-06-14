use std::io::{Cursor, Read};

use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    body::Bytes,
    extract::{Query, State},
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, CurrentTime, IdGenerator, http_error, UserSession};
use crate::models::{Note, NoteFormat, Timestamp};
use crate::utils::get_title_from_body;


/// Query parameter extractor for note_import. The filename is required (the handler rejects a
/// request that omits it); it is typed as an Option only so that a missing value reaches the
/// handler, which returns our own error message rather than a generic extractor rejection.
#[derive(Deserialize)]
pub struct ImportNotesParams {
    pub filename: Option<String>,
}

/// This is the common structure that all import formats convert into before using it to
/// create a note. Every single field is optional other than that body of the note.
#[derive(Default)]
struct ImportedNoteData {
    note_id: Option<String>,
    #[allow(dead_code)] version_id: Option<u32>,
    title: Option<String>,
    create_time: Option<String>,
    modify_time: Option<String>,
    format: Option<String>, // format arrives as a string
    body: String, // body isn't optional
}

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
        .item("create_time", AttributeValue::S(note.create_time.to_string()))
        .item("modify_time", AttributeValue::S(note.modify_time.to_string()))
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
) -> Result<Option<Note>, String> {
    let result = state.dynamo_client
        .get_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await
        .map_err(|err| err.to_string())?;
    Ok(match result.item {
        None => None,
        Some(item) => Some(Note::try_from(item)?)
    })
}

/// Decide how to read an upload that isn't a zip file, using the filename extension as a strong
/// hint. A `.json` file must parse as a known JSON format; a `.txt` file becomes a single note.
/// For any other extension we sniff: try JSON first, and otherwise treat the whole upload as a
/// single plain-text note.
fn extract_note_data_from_non_zip(
    body: &[u8],
    filename: &str,
) -> Result<Vec<ImportedNoteData>, String> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".json") {
        extract_note_data_from_json(body)
    } else if lower.ends_with(".txt") {
        extract_single_text_note(body, filename)
    } else {
        extract_note_data_from_json(body)
            .or_else(|_| extract_single_text_note(body, filename))
    }
}

/// Turn a whole text file into a single note, with the title derived from the filename (minus
/// its extension). A file that isn't valid UTF-8 text is rejected.
fn extract_single_text_note(
    body: &[u8],
    filename: &str,
) -> Result<Vec<ImportedNoteData>, String> {
    let text = std::str::from_utf8(body)
        .map_err(|_| "file is not valid UTF-8 text".to_string())?
        .to_string();
    let title = filename.rsplit_once('.').map_or(filename, |(stem, _)| stem).to_string();
    Ok(vec![ImportedNoteData {
        title: Some(title),
        body: text,
        ..Default::default()
    }])
}

/// Read the notes from a JSON file laid out like the file that mini-notes uses for export (but
/// which may be missing some of the fields).
///
/// DESIGN NOTE: The code is currently ignoring any value of version_id that was provided by the
/// imported JSON. That might or might not be the behavior we want in the long run.
fn extract_note_data_from_json(body: &[u8]) -> Result<Vec<ImportedNoteData>, String> {
    let parsed: JsonValue = serde_json::from_slice(body)
        .map_err(|err| format!("invalid JSON: {err}"))?;

    match sniff_json_format(&parsed) {
        Some(JsonFormat::MiniNotes) => extract_note_data_from_mini_notes_json(&parsed),
        Some(JsonFormat::SimpleNote) => extract_note_data_from_simplenote_json(&parsed),
        None => Err("JSON format not recognized".to_string()),
    }
}

/// An enum for the list of known JSON formats we can read from.
enum JsonFormat {
    MiniNotes,
    SimpleNote
}

/// Examine a parsed JSON file and decide which known format it matches (if any).
fn sniff_json_format(parsed: &JsonValue) -> Option<JsonFormat> {
    let mini_notes_array = parsed.get("notes").and_then(|v| v.as_array());
    if mini_notes_array.is_some() {
        return Some(JsonFormat::MiniNotes);
    }
    if let Some(simplenotes_array) = parsed.get("activeNotes").and_then(|v| v.as_array()) {
        if simplenotes_array.iter().all(|note| {
            note.get("content").is_some()
                && note.get("creationDate").is_some()
                && note.get("lastModified").is_some()
        }) {
            return Some(JsonFormat::SimpleNote);
        }
    }
    None
}

/// Extract data from mini-notes own JSON format (allowing for any fields to be missing).
fn extract_note_data_from_mini_notes_json(parsed: &JsonValue) -> Result<Vec<ImportedNoteData>, String> {
    Ok(parsed.get("notes")
        .and_then(|v| v.as_array())
        .ok_or("JSON must contain a \"notes\" array")?
        .iter()
        .map(|v: &JsonValue| ImportedNoteData {
            note_id: get_str_field(v, "note_id"),
            version_id: None,
            title: get_str_field(v, "title"),
            create_time: get_str_field(v, "create_time"),
            modify_time: get_str_field(v, "modify_time"),
            format: get_str_field(v, "format"),
            body: get_str_field(v, "body").unwrap_or_default(), // default to empty body
        })
        .collect()
    )
}

/// Extract data from SimpleNote's JSON format.
///
/// This does a bunch of checking that shouldn't be needed: verifying that activeNotes exists,
/// and dealing with missing fields. Currently, these things can't happen because our sniffer
/// verifies those things.
fn extract_note_data_from_simplenote_json(parsed: &JsonValue) -> Result<Vec<ImportedNoteData>, String> {
    Ok(parsed.get("activeNotes")
        .and_then(|v| v.as_array())
        .ok_or("JSON must contain an \"activeNotes\" array")?
        .iter()
        .filter(|v| {
            v.get("content").is_some()
                && v.get("creationDate").is_some()
                && v.get("lastModified").is_some()
        })
        .map(|v: &JsonValue| ImportedNoteData {
            create_time: get_str_field(v, "creationDate"),
            modify_time: get_str_field(v, "lastModified"),
            body: get_str_field(v, "content").unwrap_or_default(),
            ..Default::default()
        })
        .collect()
    )
}

/// A utility function: gets a field in a JSON object and returns it as a String, or returns
/// None if any of the assumptions fail.
fn get_str_field(v: &JsonValue, field_name: &str) -> Option<String> {
    v.get(field_name)
        .and_then(JsonValue::as_str)
        .map(ToOwned::to_owned)
}


/// Import notes from a zip file of text files.
fn extract_note_data_from_zip(
    body: &[u8],
) -> Result<Vec<ImportedNoteData>, String> {
    let reader = Cursor::new(body);
    let mut archive = zip::ZipArchive::new(reader)
        .map_err(|err| format!("invalid zip file: {err}"))?;

    let mut entries: Vec<ImportedNoteData> = Vec::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)
            .map_err(|err| format!("zip read error: {err}"))?;

        let name = file.name().to_string();
        if !name.ends_with(".txt") {
            // DESIGN NOTE: any file not ending in .txt is ignored (without producing an error)
            continue;
        }

        let title = name.strip_suffix(".txt").unwrap_or(&name).to_string();

        let mut body = String::new();
        file.read_to_string(&mut body)
            .map_err(|err| format!("error reading '{name}' from zip: {err}"))?;

        entries.push(ImportedNoteData {
            title: Some(title),
            body,
            ..Default::default()
        });
    }

    Ok(entries)
}

/// Returns true if this zip looks like a Samsung Notes .sdocx file, which we detect by the
/// presence of its `note.note` document entry. (A .sdocx is itself a zip, so we need this to
/// tell it apart from a plain zip of .txt files.)
fn zip_is_sdocx(body: &[u8]) -> bool {
    match zip::ZipArchive::new(Cursor::new(body)) {
        Ok(mut archive) => archive.by_name("note.note").is_ok(),
        Err(_) => false,
    }
}

/// Import the text notes from a Samsung Notes .sdocx file. Handwriting strokes, PDF content, and
/// media are ignored; only typed text is extracted. The actual parsing lives in the
/// `samsung_notes` module; here we just map its output into `ImportedNoteData`.
fn extract_note_data_from_sdocx(body: &[u8]) -> Result<Vec<ImportedNoteData>, String> {
    Ok(crate::samsung_notes::extract_text_notes(body)?
        .into_iter()
        .map(|note| ImportedNoteData {
            create_time: note.create_time,
            modify_time: note.modify_time,
            body: note.body,
            ..Default::default()
        })
        .collect())
}

// Given a collection of ImportedNoteData, go ahead and write the notes to the user's data.
async fn create_imported_notes(
    state: &AppState,
    user_id: &str,
    current_time: &CurrentTime,
    generate_id: fn() -> String,
    imported_notes: Vec<ImportedNoteData>
) -> Result<ImportResult, String> {
    let mut result = ImportResult::new();

    for note_data in imported_notes {

        let existing_note = match note_data.note_id {
            Some(ref note_id) => {
                // Perform a lookup of the existing note
                get_existing_note_info(state, user_id, note_id).await?
            }
            None => None
        };

        // user_id: always from environment (logged-in user)
        let user_id = user_id.to_string();

        // note_id: use provided or make one up
        let note_id = note_data.note_id
            .unwrap_or_else(generate_id);

        // DESIGN NOTE: The code is currently ignoring any value of version_id that was
        // provided by the imported JSON. That might or might not be the behavior we want
        // in the long run.

        // version_id: use existing version + 1, or 0 if there is no existing note
        let version_id: u32 = match existing_note {
            Some(ref note) => note.version_id + 1,
            None => 0
        };

        // body: provided value
        let body = note_data.body;

        // title: provided value, else existing note's title, else first 40 chars of first non-blank line of body, else "note".
        let title: String = note_data.title
            .or(existing_note.as_ref().map(|x| x.title.clone()))
            .unwrap_or_else(|| get_title_from_body(&body));

        // create_time: provided value, else existing note's value, else now
        let create_time: Timestamp = note_data.create_time
            .map(|x: String| Timestamp::from_str(&x))
            .and_then(|x| x.ok()) // treat a badly formatted timestamp as if it weren't there
            .or(existing_note.as_ref().map(|x| x.create_time))
            .unwrap_or(current_time.timestamp);

        // modify_time: provided value, else now
        let modify_time: Timestamp = note_data.modify_time
            .map(|x: String| Timestamp::from_str(&x))
            .and_then(|x| x.ok()) // treat a badly formatted timestamp as if it weren't there
            .unwrap_or(current_time.timestamp);

        // format: provided value as enum, else PlainText
        let format: NoteFormat = match note_data.format {
            Some(f) => NoteFormat::parse(&f).unwrap_or(NoteFormat::PlainText),
            None => NoteFormat::PlainText
        };

        // undo_stack: no undo history
        let undo_stack: Vec<String> = Vec::new();

        let note = Note {
            user_id,
            note_id,
            version_id,
            title,
            create_time,
            modify_time,
            format,
            body,
            undo_stack,
            delete_time: None,
        };
        put_note(state, note).await?;
        match existing_note {
            Some(_) => result.notes_updated += 1,
            None => result.notes_created += 1,
        }
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
    Query(params): Query<ImportNotesParams>,
    body: Bytes,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    let Some(filename) = params.filename.filter(|name| !name.is_empty()) else {
        return Err(http_error(400, "filename query parameter is required"));
    };

    info!(user_id, body_len = body.len(), table = state.notes_table_name, "importing notes");

    let imported_notes: Vec<ImportedNoteData> = if body.starts_with(ZIP_MAGIC_BYTES) {
        if zip_is_sdocx(&body) {
            extract_note_data_from_sdocx(&body)
        } else {
            extract_note_data_from_zip(&body)
        }
    } else {
        extract_note_data_from_non_zip(&body, &filename)
    }.map_err(|err| http_error(400, &err))?;

    let import_result = create_imported_notes(&state, &user_id, &current_time, generate_id, imported_notes)
        .await
        .map_err(|err| http_error(500, &err))?;

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
    use axum::extract::Query;
    use axum::http::StatusCode;
    use zip::write::{SimpleFileOptions, ZipWriter};

    fn fake_id() -> String { "TESTIMP001".to_string() }

    fn import_params(filename: Option<&str>) -> Query<ImportNotesParams> {
        Query(ImportNotesParams { filename: filename.map(str::to_string) })
    }

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
            import_params(None),
            Bytes::from_static(b"{}"),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn test_import_invalid_utf8_rejected() {
        // A .txt upload whose bytes aren't valid UTF-8 text is rejected. No DynamoDB calls
        // are expected.
        let client = test_dynamo_client(vec![]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(Some("note.txt")),
            Bytes::from_static(&[0xFF, 0xFE, 0xFF]),
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
            import_params(Some("notes.json")),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 2);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_json_updates_existing() {
        // get_item returns existing note, then put_item for update
        let get_response = r#"{"Item":{"user_id":{"S":"user1"},"note_id":{"S":"existing1"},"version_id":{"N":"3"},"title":{"S":"Old Title"},"create_time":{"S":"2026-01-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-02-01T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Old body"}}}"#;
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
            import_params(Some("notes.json")),
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
            import_params(Some("notes.json")),
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
            import_params(Some("export.zip")),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 2);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_sdocx_creates_note() {
        // One put_item for the single text note recovered from the Samsung Notes sample.
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
        ]);

        let body = Bytes::from_static(
            include_bytes!("../../../../sample_docs/Notes_260512_174108.sdocx"),
        );

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(Some("Notes_260512_174108.sdocx")),
            body,
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
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
            import_params(Some("export.zip")),
            Bytes::from(body),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_txt_creates_single_note() {
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
        ]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(Some("Grocery List.txt")),
            Bytes::from_static(b"milk\neggs"),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_txt_with_json_content_stays_text() {
        // A .txt file whose contents happen to be valid mini-notes JSON. The filename hint wins,
        // so this becomes ONE plain-text note rather than being parsed into two notes. We supply
        // only a single put_item, so parsing it as JSON would exhaust the replay and fail.
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
        ]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(Some("looks_like.txt")),
            Bytes::from_static(br#"{"notes":[{"body":"a"},{"body":"b"}]}"#),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_json_extension_invalid_rejected() {
        // A .json file that doesn't parse is an error: the hint wins, so we do not fall back to
        // treating it as text. No DynamoDB calls are expected.
        let client = test_dynamo_client(vec![]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(Some("broken.json")),
            Bytes::from_static(b"this is not json"),
        ).await;

        let (status, _) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn test_import_unknown_extension_plain_text_fallback() {
        // An extension that is neither .json nor .txt and content that isn't valid JSON: sniffing
        // falls back to a single plain-text note.
        let client = test_dynamo_client(vec![
            replay_ok(PUT_OK),
        ]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(Some("notes.md")),
            Bytes::from_static(b"just some plain text"),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["notes_created"], 1);
        assert_eq!(json["notes_updated"], 0);
    }

    #[tokio::test]
    async fn test_import_missing_filename_rejected() {
        // The filename query parameter is required; a request without it is rejected before any
        // parsing or DynamoDB calls happen.
        let client = test_dynamo_client(vec![]);

        let result = handle_import_notes(
            test_state(client),
            test_user_session("user1"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            import_params(None),
            Bytes::from_static(br#"{"notes":[{"body":"a"}]}"#),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "filename query parameter is required");
    }

    #[test]
    fn test_single_text_note_title_from_filename() {
        let entries = extract_single_text_note(b"hello world", "My Note.txt").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].title.as_deref(), Some("My Note"));
        assert_eq!(entries[0].body, "hello world");
    }

    #[test]
    fn test_single_text_note_rejects_invalid_utf8() {
        let result = extract_single_text_note(&[0xFF, 0xFE], "x.txt");
        assert!(result.is_err());
    }
}
