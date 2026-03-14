use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use axum::{Router, extract::{Path, Query, State}, response::Json, http::StatusCode, routing::get};
use serde_json::json;
use serde_json::value::Value as JsonValue;
use rand::RngExt;
use tracing::info;
use serde::Deserialize;

// ========== Constants ==========

const NOTES_PER_BATCH: i32 = 100;

// ========== Data Structures ==========

/// An enum for the various kinds of notes we support. Right now it is ONLY one
/// kind (plain text).
enum NoteFormat {
    PlainText,
}

impl Display for NoteFormat {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", match self {
            NoteFormat::PlainText => "PlainText"
        })
    }
}


/// A struct for the contents of a note.
struct Note {
    user_id: String,
    note_id: String,
    version_id: u64,
    title: String,
    create_time: String,
    modify_time: String,
    format: NoteFormat,
    body: String,
}

/// A struct for the header of a note.
struct NoteHeader {
    user_id: String,
    note_id: String,
    version_id: u64,
    title: String,
    modify_time: String,
    format: NoteFormat,
}

type DynamoDBRecord = HashMap<String, AttributeValue>;

/// Function to validate a CustomId; returns true if it is valid.
fn is_valid_id(id: &str) -> bool {
    // 10 bytes long, all ascii [0-9A-Za-z_~].
    id.len() == ID_LENGTH && id.chars().all(|x| x.is_ascii_alphanumeric() || x == '_' || x == '~')
}

const ID_ALPHABET: &[u8; 64] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~";
const ID_LENGTH: usize = 10;

/// Generate a random id: a 10-character base-64 string using ID_ALPHABET.
fn generate_id() -> String {
    let mut rng = rand::rng();
    (0..ID_LENGTH)
        .map(|_| ID_ALPHABET[rng.random_range(0..64)] as char)
        .collect()
}

/// Helper for reading string fields from DynamoDB.
fn get_s(item: &DynamoDBRecord, field: &str) -> Result<String, String> {
    item.get(field)
        .ok_or_else(|| format!("missing field '{field}'"))?
        .as_s()
        .map(|s| s.to_string())
        .map_err(|_| format!("field '{field}' is not a string"))
}

/// Helper for reading number fields from DynamoDB.
fn get_n_as_u64(item: &DynamoDBRecord, field: &str) -> Result<u64, String> {
    let n_str = item.get(field)
        .ok_or_else(|| format!("missing field '{field}'"))?
        .as_n()
        .map_err(|_| format!("field '{field}' is not a number"))?;
    n_str.parse::<u64>()
        .map_err(|_| format!("field '{field}' is not a valid u64"))
}

/// Helper for reading the enum NoteFormat fields from DynamoDB.
fn parse_note_format(s: &str) -> Result<NoteFormat, String> {
    match s {
        "PlainText" => Ok(NoteFormat::PlainText),
        _ => Err(format!("unknown note format '{s}'")),
    }
}

/// Convert a DynamoDBRecord into a Note. Returns an error if the record isn't formatted
/// exactly as expected.
impl TryFrom<&DynamoDBRecord> for Note {
    type Error = String;

    fn try_from(item: &DynamoDBRecord) -> Result<Self, Self::Error> {
        Ok(Note {
            user_id: get_s(item, "user_id")?,
            note_id: get_s(item, "note_id")?,
            version_id: get_n_as_u64(item, "version_id")?,
            title: get_s(item, "title")?,
            create_time: get_s(item, "create_time")?,
            modify_time: get_s(item, "modify_time")?,
            format: parse_note_format(&get_s(item, "format")?)?,
            body: get_s(item, "body")?,
        })
    }
}

/// Convert a Note into a JsonValue suitable to return to the caller.
impl From<Note> for JsonValue {
    fn from(note: Note) -> Self {
        json!({
            "user_id": note.user_id,
            "note_id": note.note_id,
            "version_id": note.version_id,
            "title": note.title,
            "create_time": note.create_time,
            "modify_time": note.modify_time,
            "format": note.format.to_string(),
            "body": note.body,
        })
    }
}

/// Convert a DynamoDBRecord into a NoteHeader. Returns an error if the record isn't formatted
/// exactly as expected.
impl TryFrom<&DynamoDBRecord> for NoteHeader {
    type Error = String;

    fn try_from(item: &DynamoDBRecord) -> Result<Self, Self::Error> {
        Ok(NoteHeader {
            user_id: get_s(item, "user_id")?,
            note_id: get_s(item, "note_id")?,
            version_id: get_n_as_u64(item, "version_id")?,
            title: get_s(item, "title")?,
            modify_time: get_s(item, "modify_time")?,
            format: parse_note_format(&get_s(item, "format")?)?,
        })
    }
}

/// Convert a Note into a JsonValue suitable to return to the caller.
impl From<NoteHeader> for JsonValue {
    fn from(note_header: NoteHeader) -> Self {
        json!({
            "user_id": note_header.user_id,
            "note_id": note_header.note_id,
            "version_id": note_header.version_id,
            "title": note_header.title,
            "modify_time": note_header.modify_time,
            "format": note_header.format.to_string(),
        })
    }
}


// ========== Utilities ==========

/// Helper to create the contents of the Err to return from an error response from an error code and a message.
fn http_error<T: TryInto<StatusCode>>(status: T, message: &str) -> HandlerErrOutput {
    (
        status.try_into().unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
        Json(json!({"error": message}))
    )
}

/// DynamoDB gives us back a "LastEvaluatedKey" map with the 3 fields user_id, note_id, and
/// modify_time when we are reading from the LSI. This converts that to a pipe-delimited
/// string in the format "user_id|modify_time|note_id" (or fails).
fn build_continue_key(last_evaluated_key: DynamoDBRecord) -> Result<String, String> {
    let user_id = get_s(&last_evaluated_key, "user_id")?;
    let note_id = get_s(&last_evaluated_key, "note_id")?;
    let modify_time = get_s(&last_evaluated_key, "modify_time")?;
    Ok(format!("{user_id}|{modify_time}|{note_id}"))
}

/// Parse a continue_key string (as returned by build_continue_key) back into a
/// DynamoDBRecord suitable for use as an exclusive_start_key.
fn parse_continue_key(continue_key: &str) -> Result<DynamoDBRecord, String> {
    let parts: Vec<&str> = continue_key.split('|').collect();
    let [user_id, modify_time, note_id] = parts.as_slice() else {
        return Err("continue_key must have exactly 3 pipe-delimited fields".to_string());
    };
    let mut key = DynamoDBRecord::new();
    key.insert("user_id".to_string(), AttributeValue::S(user_id.to_string()));
    key.insert("note_id".to_string(), AttributeValue::S(note_id.to_string()));
    key.insert("modify_time".to_string(), AttributeValue::S(modify_time.to_string()));
    Ok(key)
}


// ========== Endpoint Logic ==========

type HandlerErrOutput = (StatusCode, Json<serde_json::Value>);
type HandlerOutput = Result<Json<serde_json::Value>, HandlerErrOutput>;

/// Common information shared by every call. Must be Clone since each thread will get a copy.
#[derive(Clone)]
struct AppState {
    dynamo_client: DynamoClient,
}


/// Query parameter extractor for get_notes.
#[derive(Deserialize)]
struct GetNotesParams {
    continue_key: Option<String>,
}

#[axum::debug_handler]
async fn handle_get_notes(
    State(state): State<AppState>,
    Query(query_params): Query<GetNotesParams>
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    info!(user_id, table, "fetching notes");

    // Parse the continuation key if provided
    let exclusive_start_key: Option<DynamoDBRecord> = match query_params.continue_key {
        Some(key) => match parse_continue_key(&key) {
            Ok(record) => Some(record),
            Err(_) => return Err(http_error(400, "invalid continue_key")),
        },
        None => None,
    };

    // Perform the query
    let result = state.dynamo_client
        .query()
        .table_name(&table)
        .index_name("notes-by-modify-time")
        .key_condition_expression("user_id = :uid")
        .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
        .limit(NOTES_PER_BATCH)
        .scan_index_forward(false)
        .set_exclusive_start_key(exclusive_start_key)
        .send()
        .await;
    let result = match result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };

    // And extract and return the results
    let Ok(continue_key) = result.last_evaluated_key
        .map(build_continue_key)
        .transpose()
    else {
        return Err(http_error(500, "continue_key invalid in DB"));
    };
    let Ok(note_headers): Result<Vec<NoteHeader>, String> = result.items
        .unwrap_or_default()
        .iter()
        .map(|item| NoteHeader::try_from(item))
        .collect()
    else {
        return Err(http_error(500, "note header is invalid in DB"));
    };
    let note_headers_json: JsonValue = note_headers.into_iter().map(JsonValue::from).collect();
    let body_json = json!({
        "note_headers": note_headers_json,
        "continue_key": continue_key,
    });
    Ok(Json(body_json))
}


/// Logic for handling the get_note command.
#[axum::debug_handler]
async fn handle_get_note(
    State(state): State<AppState>,
    Path(note_id): Path<String>
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    if ! is_valid_id(&note_id) {
        return Err(http_error(404, "note_id has invalid characters"));
    }

    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    info!(user_id, note_id, table, "fetching note");

    let result = state.dynamo_client
        .get_item()
        .table_name(&table)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await;
    let result = match result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };
    let item: DynamoDBRecord = match result.item {
        Some(item) => item,
        None => return Err(http_error(404, "note not found")),
    };
    let note: JsonValue = match Note::try_from(&item) {
        Ok(note) => note.into(),
        Err(err) => {
            info!(err, "note is invalid in DB");
            return Err(http_error(500, "note is invalid in DB"));
        }
    };

    let body_json = json!({"note": note});
    Ok(Json(body_json))
}


// ========== Routing and Framework ==========


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

    // Kick off main event loop
    let state = AppState {
        dynamo_client: client,
    };
    let app = Router::new()
        .route("/api/v1/notes", get(handle_get_notes))
        .route("/api/v1/notes/{note_id}", get(handle_get_note))
        .with_state(state);
    lambda_http::run(app).await
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_get_notes_params_ignores_extra_params() {
        let uri: axum::http::Uri = "http://example.com/path?foo=hello&bar=42".parse().unwrap();
        let query: Query<GetNotesParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.continue_key, None);
    }

    #[test]
    fn parse_get_notes_params_parses_simple_strings() {
        let uri: axum::http::Uri = "http://example.com/path?continue_key=abc".parse().unwrap();
        let query: Query<GetNotesParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.continue_key, Some("abc".to_string()));
    }

    #[test]
    fn parse_get_notes_params_parses_real_example_with_escaped_values() {
        let uri: axum::http::Uri = "http://example.com/path?continue_key=Xq3_mK8~pL%7C2026-03-10T22%3A19%3A00.000Z%7Ck7Rp~2mXvQ".parse().unwrap();
        let query: Query<GetNotesParams> = Query::try_from_uri(&uri).unwrap();
        assert_eq!(query.continue_key, Some("Xq3_mK8~pL|2026-03-10T22:19:00.000Z|k7Rp~2mXvQ".to_string()));
    }
}
