use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use lambda_http::{run, service_fn, Body, Error, Request, Response};
use serde_json::json;
use serde_json::value::Value as JsonValue;
use rand::RngExt;
use tracing::info;

// ========== Constants ==========

const NOTES_PER_BATCH: i32 = 2;

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
    // 10 bytes long, all ascii [0-9A-Za-z_$].
    id.len() == ID_LENGTH && id.chars().all(|x| x.is_ascii_alphanumeric() || x == '_' || x == '$')
}

const ID_ALPHABET: &[u8; 64] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_$";
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

/// Helper to create an error response from an error code and a message.
fn http_error(status: u16, message: &str) -> Result<Response<Body>, Error> {
    Ok(Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::Text(json!({"error": message}).to_string()))?
    )
}

/// DynamoDB gives us back a "LastEvaluatedKey" map with the 3 fields user_id, note_id, and
/// modify_time when we are reading from the LSI. This converts that to a String (or fails).
fn build_continuation_key(last_evaluated_key: DynamoDBRecord) -> Result<String, String> {
    let user_id = get_s(&last_evaluated_key, "user_id")?;
    let note_id = get_s(&last_evaluated_key, "note_id")?;
    let modify_time = get_s(&last_evaluated_key, "modify_time")?;
    Ok(json!({
        "user_id": user_id,
        "note_id": note_id,
        "modify_time": modify_time,
    }).to_string())
}


// ========== Endpoint Logic ==========

/// Logic for handling the get_notes command.
async fn handle_get_notes(dynamo_client: &DynamoClient, user_id: &str) -> Result<Response<Body>, Error> {

    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    info!(user_id, table, "fetching notes");

    let result = dynamo_client
        .query()
        .table_name(&table)
        .index_name("notes-by-modify-time")
        .key_condition_expression("user_id = :uid")
        .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
        .limit(NOTES_PER_BATCH)
        .scan_index_forward(false)
        .send()
        .await?;
    let Ok(continuation_key) = result.last_evaluated_key
        .map(build_continuation_key)
        .transpose()
    else {
        return http_error(500, "continuation_key invalid in DB");
    };
    let Ok(note_headers): Result<Vec<NoteHeader>, String> = result.items
        .unwrap_or_default()
        .iter()
        .map(|item| NoteHeader::try_from(item))
        .collect()
    else {
        return http_error(500, "note header is invalid in DB");
    };
    let note_headers_json: JsonValue = note_headers.into_iter().map(JsonValue::from).collect();

    let body = json!({
        "note_headers": note_headers_json,
        "continuation_key": continuation_key,
    });

    Ok(Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Body::Text(body.to_string()))?
    )
}


/// Logic for handling the get_note command.
async fn handle_get_note(dynamo_client: &DynamoClient, user_id: &str, note_id: &str) -> Result<Response<Body>, Error> {
    if ! is_valid_id(note_id) {
        return http_error(404, "note_id has invalid characters");
    }

    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    info!(user_id, note_id, table, "fetching note");

    let result = dynamo_client
        .get_item()
        .table_name(&table)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await?;
    let item: DynamoDBRecord = match result.item {
        Some(item) => item,
        None => return http_error(404, "note not found"),
    };
    let note: JsonValue = match Note::try_from(&item) {
        Ok(note) => note.into(),
        Err(err) => {
            info!(err, "note is invalid in DB");
            return http_error(500, "note is invalid in DB");
        }
    };

    Ok(Response::builder()
        .status(200)
        .header("content-type", "application/json")
        .body(Body::Text(json!({"note": note}).to_string()))?)
}


/// This function performs the operation whenever the lambda is invoked. It receives an
/// HTTP request and a handle to the DynamoDB client, and returns a successful HTTP response
/// or an HTTP error.
async fn handler(dynamo_client: &DynamoClient, request: Request) -> Result<Response<Body>, Error> {
    // Later we will get the user_id from a cookie. For now, it is hard-coded:
    let user_id = "Xq3_mK8$pL";

    // Dispatch based on the: "/api/v1/notes" or "/api/v1/notes/{note_id}"
    let path = request.uri().path();
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    return match path_segments.as_slice() {
        ["api", "v1", "notes"] => handle_get_notes(dynamo_client, user_id).await,
        ["api", "v1", "notes", note_id] => handle_get_note(dynamo_client, user_id, *note_id).await,
        _ => http_error(404, "not found"),
    }
}


// ========== Routing and Framework ==========


/// Entry point for initializing the lambda's environment, invoked when the lambda is
/// instantiated. Must call run() to perform the main event loop.
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

    // Kick off main event loop
    run(service_fn(move |request: Request| {
        let client = client.clone();
        async move { handler(&client, request).await }
    }))
    .await
}
