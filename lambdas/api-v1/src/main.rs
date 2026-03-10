use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use lambda_http::{run, service_fn, Body, Error, Request, Response};
use serde_json::json;
use serde_json::value::Value as JsonValue;
use rand::RngExt;
use tracing::info;

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

/// Convert a DynamoDB note item into JSON. Returns None if any field is the wrong type or
/// any required field is missing.
fn note_from_db(item: &DynamoDBRecord) -> Option<JsonValue> {
    let note_id      = item.get("note_id")     ?.as_s().ok()?;
    let title   = item.get("title")  ?.as_s().ok()?;
    let content = item.get("content")?.as_s().ok()?;
    Some(json!({"note_id": note_id, "title": title, "content": content}))
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
            "body": note.body})
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


// ========== Endpoint Logic ==========


/// This function performs the operation whenever the lambda is invoked. It receives an
/// HTTP request and a handle to the DynamoDB client, and returns a successful HTTP response
/// or an HTTP error.
async fn handler(dynamo_client: &DynamoClient, request: Request) -> Result<Response<Body>, Error> {
    let table = std::env::var("TABLE_NAME").unwrap_or_else(|_| "mini-notes-notes-dev".to_string());

    // Later we will get the user_id from a cookie. For now, it is hard-coded:
    let user_id = "Xq3_mK8$pL";

    // Extract note_id from the path: /api/v1/notes/{note_id}
    let path = request.uri().path();
    let path_segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    let note_id = match path_segments.as_slice() {
        ["api", "v1", "notes", note_id] if is_valid_id(note_id) => *note_id,
        ["api", "v1", "notes", _] => return http_error(404, "note_id has invalid characters"),
        _ => return http_error(404, "not found"),
    };

    info!(note_id, table, "fetching note");

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
