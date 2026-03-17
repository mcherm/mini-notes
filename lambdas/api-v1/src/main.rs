mod passwords;

use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use aws_sdk_dynamodb::Client as DynamoClient;
use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    Router,
    extract::{Path, Query, State, FromRequestParts},
    response::Json,
    http::{Method, StatusCode, header, request::Parts},
    routing::{get, put, post, delete}
};
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};
use time::{UtcDateTime, format_description::well_known::Iso8601};
use tower_http::cors::CorsLayer;
use tracing::info;
use rand::RngExt;


// ========== Constants ==========

const NOTES_PER_BATCH: i32 = 100;

// ========== Data Structures ==========

/// An enum for the various kinds of notes we support. Right now it is ONLY one
/// kind (plain text).
#[derive(Debug, Deserialize)]
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

/// Helper for reading the enum NoteFormat fields from DynamoDB.
fn parse_note_format(s: &str) -> Result<NoteFormat, String> {
    match s {
        "PlainText" => Ok(NoteFormat::PlainText),
        _ => Err(format!("unknown note format '{s}'")),
    }
}



/// An enum for the various kinds of user we support. Right now it is ONLY one
/// kind ("Earlybird")
#[derive(Debug, Deserialize)]
enum UserType {
    Earlybird,
}

impl Display for UserType {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", match self {
            UserType::Earlybird => "Earlybird"
        })
    }
}

/// Helper for reading the enum UserType fields from DynamoDB.
fn parse_user_type(s: &str) -> Result<UserType, String> {
    match s {
        "Earlybird" => Ok(UserType::Earlybird),
        _ => Err(format!("unknown user type '{s}'")),
    }
}


/// A struct for the contents of a note.
struct Note {
    user_id: String,
    note_id: String,
    version_id: u32,
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
    version_id: u32,
    title: String,
    modify_time: String,
    format: NoteFormat,
}

/// A struct for a user.
struct User {
    user_id: String,
    email: String,
    password_hash: String,
    user_type: UserType,
}

/// A struct for a session.
struct Session {
    session_id: String,
    user_id: String,
    expire_time: String,
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
fn get_n_as_u32(item: &DynamoDBRecord, field: &str) -> Result<u32, String> {
    let n_str = item.get(field)
        .ok_or_else(|| format!("missing field '{field}'"))?
        .as_n()
        .map_err(|_| format!("field '{field}' is not a number"))?;
    n_str.parse::<u32>()
        .map_err(|_| format!("field '{field}' is not a valid u32"))
}

/// Convert a DynamoDBRecord (which this consues) into a Note. Returns an error if the record
/// isn't formatted exactly as expected.
impl TryFrom<DynamoDBRecord> for Note {
    type Error = String;

    fn try_from(item: DynamoDBRecord) -> Result<Self, Self::Error> {
        Ok(Note {
            user_id: get_s(&item, "user_id")?,
            note_id: get_s(&item, "note_id")?,
            version_id: get_n_as_u32(&item, "version_id")?,
            title: get_s(&item, "title")?,
            create_time: get_s(&item, "create_time")?,
            modify_time: get_s(&item, "modify_time")?,
            format: parse_note_format(&get_s(&item, "format")?)?,
            body: get_s(&item, "body")?,
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
impl TryFrom<DynamoDBRecord> for NoteHeader {
    type Error = String;

    fn try_from(item: DynamoDBRecord) -> Result<Self, Self::Error> {
        Ok(NoteHeader {
            user_id: get_s(&item, "user_id")?,
            note_id: get_s(&item, "note_id")?,
            version_id: get_n_as_u32(&item, "version_id")?,
            title: get_s(&item, "title")?,
            modify_time: get_s(&item, "modify_time")?,
            format: parse_note_format(&get_s(&item, "format")?)?,
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

/// Convert a DynamoDBRecord (which this consumes) into a User. Returns an error if the record
/// isn't formatted exactly as expected.
impl TryFrom<DynamoDBRecord> for User {
    type Error = String;

    fn try_from(item: DynamoDBRecord) -> Result<Self, Self::Error> {
        Ok(User {
            user_id: get_s(&item, "user_id")?,
            email: get_s(&item, "email")?,
            password_hash: get_s(&item, "password_hash")?,
            user_type: parse_user_type(&get_s(&item, "user_type")?)?,
        })
    }
}

/// Convert a Note into a JsonValue suitable to return to the caller.
impl From<User> for JsonValue {
    fn from(user: User) -> Self {
        json!({
            "user_id": user.user_id,
            "email": user.email,
            "password_hash": user.password_hash,
            "user_type": user.user_type.to_string(),
        })
    }
}

/// Convert a DynamoDBRecord (which this consumes) into a User. Returns an error if the record
/// isn't formatted exactly as expected.
impl TryFrom<DynamoDBRecord> for Session {
    type Error = String;

    fn try_from(item: DynamoDBRecord) -> Result<Self, Self::Error> {
        Ok(Session {
            session_id: get_s(&item, "session_id")?,
            user_id: get_s(&item, "user_id")?,
            expire_time: get_s(&item, "expire_time")?,
        })
    }
}

/// Convert a Note into a JsonValue suitable to return to the caller.
impl From<Session> for JsonValue {
    fn from(session: Session) -> Self {
        json!({
            "session_id": session.session_id,
            "user_id": session.user_id,
            "expire_time": session.expire_time,
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

/// When traversing the index used by get_notes, DynamoDB gives us back a "LastEvaluatedKey"
/// map with the 3 fields user_id, note_id, and modify_time when we are reading from the LSI.
/// This converts that to a pipe-delimited string in the format "user_id|modify_time|note_id"
/// (or fails).
fn build_get_notes_continue_key(last_evaluated_key: DynamoDBRecord) -> Result<String, String> {
    let user_id = get_s(&last_evaluated_key, "user_id")?;
    let note_id = get_s(&last_evaluated_key, "note_id")?;
    let modify_time = get_s(&last_evaluated_key, "modify_time")?;
    Ok(format!("{user_id}|{modify_time}|{note_id}"))
}

/// Parse a continue_key string (as returned by build_get_notes_continue_key()) back into a
/// DynamoDBRecord suitable for use as an exclusive_start_key.
fn parse_get_notes_continue_key(continue_key: &str) -> Result<DynamoDBRecord, String> {
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

/// When traversing the base table used by search_notes, DynamoDB gives us back a
/// "LastEvaluatedKey" map with the 2 fields user_id and note_id. This function converts
/// that to a pipe-delimited string in the format "user_id|note_id" (or fails).
fn build_search_notes_continue_key(last_evaluated_key: DynamoDBRecord) -> Result<String, String> {
    let user_id = get_s(&last_evaluated_key, "user_id")?;
    let note_id = get_s(&last_evaluated_key, "note_id")?;
    Ok(format!("{user_id}|{note_id}"))
}

/// Parse a continue_key string (as returned by build_search_notes_continue_key()) back into a
/// DynamoDBRecord suitable for use as an exclusive_start_key.
fn parse_search_notes_continue_key(continue_key: &str) -> Result<DynamoDBRecord, String> {
    let parts: Vec<&str> = continue_key.split('|').collect();
    let [user_id, note_id] = parts.as_slice() else {
        return Err("continue_key must have exactly 2 pipe-delimited fields".to_string());
    };
    let mut key = DynamoDBRecord::new();
    key.insert("user_id".to_string(), AttributeValue::S(user_id.to_string()));
    key.insert("note_id".to_string(), AttributeValue::S(note_id.to_string()));
    Ok(key)
}


// ========== Endpoint Logic ==========

type HandlerErrOutput = (StatusCode, Json<serde_json::Value>);
type HandlerOutput = Result<Json<serde_json::Value>, HandlerErrOutput>;

/// Common information shared by every call. Must be Clone since each thread will get a copy.
#[derive(Clone)]
struct AppState {
    dynamo_client: DynamoClient,
    notes_table_name: String,
    users_table_name: String,
    sessions_table_name: String,
}

/// Extractor for getting the time from the system clock.
struct CurrentTime{
    date_time: UtcDateTime,
    time_string: String,
}

/// Make CurrentTime into an extractor that can be used by handlers if declared as an argument.
impl FromRequestParts<AppState> for CurrentTime {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(_parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        let date_time = UtcDateTime::now();
        match date_time.format(&Iso8601::DEFAULT) {
            Ok(time_string) => Ok(CurrentTime {
                date_time,
                time_string
            }),
            Err(_) => Err(http_error(500, "cannot read system clock"))
        }
    }
}

/// Extractor for generating new IDs. In production, axum resolves this using
/// generate_id(); in tests, callers construct it directly with any function.
struct IdGenerator(fn() -> String);

impl FromRequestParts<AppState> for IdGenerator {
    type Rejection = HandlerErrOutput;

    async fn from_request_parts(_parts: &mut Parts, _state: &AppState) -> Result<Self, Self::Rejection> {
        Ok(IdGenerator(generate_id))
    }
}

/// Query parameter extractor for get_notes.
#[derive(Deserialize)]
struct GetNotesParams {
    continue_key: Option<String>,
}

/// Handler for getting a list of notes (with pagination). Returns them by modify_date descending.
#[axum::debug_handler]
async fn handle_get_notes(
    State(state): State<AppState>,
    Query(query_params): Query<GetNotesParams>
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    info!(user_id, table = state.notes_table_name, "fetching notes");

    // Parse the continuation key if provided
    let exclusive_start_key: Option<DynamoDBRecord> = match query_params.continue_key {
        Some(key) => match parse_get_notes_continue_key(&key) {
            Ok(record) => Some(record),
            Err(_) => return Err(http_error(400, "invalid continue_key")),
        },
        None => None,
    };

    // Perform the query
    let result = state.dynamo_client
        .query()
        .table_name(&state.notes_table_name)
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
        .map(build_get_notes_continue_key)
        .transpose()
    else {
        return Err(http_error(500, "continue_key invalid in DB"));
    };
    let Ok(note_headers): Result<Vec<NoteHeader>, String> = result.items
        .unwrap_or_default()
        .into_iter()
        .map(NoteHeader::try_from)
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


/// A struct for the things that are passed in as part of the body when a new note is created.
#[derive(Debug, Deserialize)]
struct NewNoteBody {
    title: String,
    body: String,
    format: NoteFormat,
}

/// Logic for handling the new_note command.
#[axum::debug_handler]
async fn handle_new_note(
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


/// Logic for handling the get_note command.
#[axum::debug_handler]
async fn handle_get_note(
    State(state): State<AppState>,
    Path(note_id): Path<String>,
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    if ! is_valid_id(&note_id) {
        return Err(http_error(404, "note_id has invalid characters"));
    }

    info!(user_id, note_id, table = state.notes_table_name, "fetching note");

    let result = state.dynamo_client
        .get_item()
        .table_name(&state.notes_table_name)
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
    let note: JsonValue = match Note::try_from(item) {
        Ok(note) => note.into(),
        Err(err) => {
            info!(err, "note is invalid in DB");
            return Err(http_error(500, "note is invalid in DB"));
        }
    };

    let body_json = json!({"note": note});
    Ok(Json(body_json))
}

/// A struct for the things that are passed in as part of the body when a note is being modified.
#[derive(Debug, Deserialize)]
struct EditNoteBody {
    title: String,
    body: String,
}

/// Logic for handling the edit_note command. This modifies a note that already exists.
#[axum::debug_handler]
async fn handle_edit_note(
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


/// Logic for handling the delete_note command.
#[axum::debug_handler]
async fn handle_delete_note(
    State(state): State<AppState>,
    Path(note_id): Path<String>
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    info!(user_id, note_id, table = state.notes_table_name, "delete note");

    let result = state.dynamo_client
        .delete_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await;
    if result.is_err() {
        return Err(http_error(500, "unable to delete note"));
    }

    let body_json = json!({});
    Ok(Json(body_json))
}

/// Query parameter extractor for search_notes.
#[derive(Deserialize)]
struct SearchNotesParams {
    search_string: String,
    continue_key: Option<String>,
}

/// Handler for getting a list of notes (with pagination). Does not return them in any
/// particular order (it's sorted by note_id, which is randomly assigned). Returns a
/// continue_key for pagination if there *may* be more to be found. Will always return
/// at least 1 matching note unless we are at the end of the list of matches. Matching
/// notes are those that have the search string literally (case sensitive) somewhere
/// in the title or body.
#[axum::debug_handler]
async fn handle_search_notes(
    State(state): State<AppState>,
    Query(query_params): Query<SearchNotesParams>
) -> HandlerOutput {
    let user_id = "Xq3_mK8~pL"; // FIXME: Hardcoded for now

    info!(user_id, table = state.notes_table_name, query_params.search_string, ?query_params.continue_key, "searching for notes");

    // Parse the continuation key if provided
    let mut exclusive_start_key: Option<DynamoDBRecord> = match query_params.continue_key {
        Some(key) => match parse_search_notes_continue_key(&key) {
            Ok(record) => Some(record),
            Err(_) => return Err(http_error(400, "invalid continue_key")),
        },
        None => None,
    };

    let mut note_headers: Vec<NoteHeader> = Vec::new();

    loop {

        // Perform the query
        let result = state.dynamo_client
            .query()
            .table_name(&state.notes_table_name)
            .key_condition_expression("user_id = :uid")
            .filter_expression("contains(title, :search) OR contains(body, :search)")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
            .expression_attribute_values(":search", AttributeValue::S(query_params.search_string.clone()))
            .limit(NOTES_PER_BATCH)
            .set_exclusive_start_key(exclusive_start_key)
            .send()
            .await;
        let result = match result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &err.to_string())),
        };

        exclusive_start_key = result.last_evaluated_key;

        // turn any new items found into notes
        let Ok(new_items): Result<Vec<NoteHeader>,String> = result
            .items.unwrap_or_default()
            .into_iter()
            .map(NoteHeader::try_from)
            .collect()
        else {
            return Err(http_error(500, "a note is invalid in DB"));
        };
        // add those notes onto our list
        note_headers.extend(new_items);

        // Exit when there are no more to find OR we've found at least 1 matching note
        if exclusive_start_key.is_none() || !note_headers.is_empty() {
            break;
        }
    }

    // Turn exclusive_start_key (DynamoDB format) into continue_key (my string encoding)
    let Ok(continue_key) = exclusive_start_key.map(build_search_notes_continue_key).transpose() else {
        return Err(http_error(500, "continue_key invalid in DB"));
    };

    let note_headers_json: JsonValue = note_headers.into_iter().map(JsonValue::from).collect();
    let body_json = json!({
        "note_headers": note_headers_json,
        "continue_key": continue_key,
    });
    Ok(Json(body_json))
}



/// A struct for the things that are passed in as part of the body when a user login occurs.
#[derive(Debug, Deserialize)]
struct UserLoginBody {
    email: String,
    password: String,
}

/// Handler for user login.
#[axum::debug_handler]
async fn handle_user_login(
    State(state): State<AppState>,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    Json(user_login_body): Json<UserLoginBody>,
) -> HandlerOutput {
    info!(email = user_login_body.email, "user login attempt");

    // Look up the user by email using the GSI
    let query_result = state.dynamo_client
        .query()
        .table_name(&state.users_table_name)
        .index_name("users-by-email")
        .key_condition_expression("email = :email")
        .expression_attribute_values(":email", AttributeValue::S(user_login_body.email))
        .limit(1)
        .send()
        .await;
    let query_result = match query_result {
        Ok(response) => response,
        Err(err) => return Err(http_error(500, &err.to_string())),
    };
    let Some(first_user) = query_result
        .items
        .and_then(|mut items| if items.is_empty() { None } else { Some(items.remove(0)) })
    else {
        return Err(http_error(401, "invalid email or password"))
    };
    let user: User = match User::try_from(first_user) {
        Ok(user) => user,
        Err(err) => {
            info!(err, "user record is invalid in DB");
            return Err(http_error(500, "user record is invalid in DB"));
        }
    };

    // Verify the password
    let password_valid = match passwords::verify_password(&user_login_body.password, &user.password_hash) {
        Ok(valid) => valid,
        Err(err) => {
            info!(%err, "password hash verification failed");
            return Err(http_error(500, "password verification error"));
        }
    };
    if !password_valid {
        return Err(http_error(401, "invalid email or password"));
    }

    // TODO: Create a Session. the session_id is created from generate_id. The user_id comes from the User we found. The expire_time is from current_time but add about 1 month.
    // TODO: Write the new Session to the Session table.
    // TODO: Return a response that creates a cookie containing the session_id.
    todo!()
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

    // Read configuration from environment
    let stage = std::env::var("STAGE")
        .expect("STAGE env var must be set");
    let allowed_origin = std::env::var("ALLOWED_ORIGIN")
        .expect("ALLOWED_ORIGIN env var must be set");

    let cors = CorsLayer::new()
        .allow_methods([Method::GET, Method::PUT, Method::POST, Method::DELETE, Method::OPTIONS])
        .allow_headers([header::CONTENT_TYPE, header::AUTHORIZATION])
        .allow_origin([allowed_origin.parse().expect("Invalid ALLOWED_ORIGIN")]);

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


#[cfg(test)]
mod tests {
    use super::*;

    /// Create a stub CurrentTime object from a string. Used for tests.
    fn current_time_stub(s: &str) -> CurrentTime {
        CurrentTime {
            date_time: UtcDateTime::parse(s, &Iso8601::DEFAULT).unwrap(),
            time_string: s.to_string(),
        }
    }

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
            .with_state(AppState {
                dynamo_client: client,
                notes_table_name: "mini-notes-notes-test".to_string(),
                users_table_name: "mini-notes-users-test".to_string(),
                sessions_table_name: "mini-notes-sessions-test".to_string(),
            });

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

    // ===== Direct handler tests =====

    /// Helper: build a DynamoClient backed by canned HTTP responses.
    fn test_dynamo_client(events: Vec<ReplayEvent>) -> DynamoClient {
        use aws_smithy_http_client::test_util::StaticReplayClient;
        let http_client = StaticReplayClient::new(events);
        let config = aws_sdk_dynamodb::Config::builder()
            .http_client(http_client)
            .region(aws_sdk_dynamodb::config::Region::new("us-east-1"))
            .credentials_provider(aws_credential_types::Credentials::new(
                "test", "test", None, None, "test"
            ))
            .behavior_version_latest()
            .build();
        DynamoClient::from_conf(config)
    }

    fn test_state(client: DynamoClient) -> State<AppState> {
        State(AppState {
            dynamo_client: client,
            notes_table_name: "mini-notes-notes-test".to_string(),
            users_table_name: "mini-notes-users-test".to_string(),
            sessions_table_name: "mini-notes-sessions-test".to_string(),
        })
    }

    fn replay_ok(response_body: &str) -> ReplayEvent {
        ReplayEvent::new(
            axum::http::Request::builder().body(SdkBody::empty()).unwrap(),
            axum::http::Response::builder()
                .status(200)
                .body(SdkBody::from(response_body.to_string()))
                .unwrap(),
        )
    }

    use aws_smithy_http_client::test_util::ReplayEvent;
    use aws_smithy_types::body::SdkBody;

    #[tokio::test]
    async fn direct_handle_get_notes_happy_path() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"My Note"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "ab12cd34ef");
        assert_eq!(headers[0]["title"], "My Note");
        assert!(json["continue_key"].is_null());
    }

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

    #[tokio::test]
    async fn direct_handle_get_note_happy_path() {
        let get_item_response = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"2"},"title":{"S":"Found Note"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Note body"}}}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["version_id"], 2);
        assert_eq!(json["note"]["title"], "Found Note");
        assert_eq!(json["note"]["body"], "Note body");
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
    async fn direct_handle_delete_note_happy_path() {
        let delete_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(delete_response)]);

        let result = handle_delete_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, json!({}));
    }

    #[tokio::test]
    async fn direct_handle_search_notes_happy_path() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"Matching Note"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_search_notes(
            test_state(client),
            Query(SearchNotesParams {
                search_string: "Matching".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "ab12cd34ef");
        assert_eq!(headers[0]["title"], "Matching Note");
        assert!(json["continue_key"].is_null());
    }

    // ===== Additional direct handler tests =====

    #[tokio::test]
    async fn direct_handle_get_notes_with_continue_key() {
        let query_response = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"zz99yy88ww"},"version_id":{"N":"1"},"title":{"S":"Second Page Note"},"modify_time":{"S":"2026-03-05T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":1}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            Query(GetNotesParams {
                continue_key: Some("Xq3_mK8~pL|2026-03-10T00:00:00.000000000Z|ab12cd34ef".to_string()),
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "zz99yy88ww");
        assert_eq!(headers[0]["title"], "Second Page Note");
    }

    #[tokio::test]
    async fn direct_handle_get_notes_empty_results() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_get_notes(
            test_state(client),
            Query(GetNotesParams { continue_key: None }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_get_note_not_found() {
        let get_item_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(get_item_response)]);

        let result = handle_get_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(json["error"], "note not found");
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

    #[tokio::test]
    async fn direct_handle_delete_note_nonexistent() {
        // DynamoDB DeleteItem succeeds even when the item doesn't exist
        let delete_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(delete_response)]);

        let result = handle_delete_note(
            test_state(client),
            Path("ab12cd34ef".to_string()),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json, json!({}));
    }

    #[tokio::test]
    async fn direct_handle_search_notes_no_matches() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":5}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_search_notes(
            test_state(client),
            Query(SearchNotesParams {
                search_string: "nonexistent".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_pagination_finds_results_on_second_page() {
        // First page: no matches but has a LastEvaluatedKey (loop continues)
        let page1 = r#"{"Items":[],"Count":0,"ScannedCount":5,"LastEvaluatedKey":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"}}}"#;
        // Second page: has a match and no LastEvaluatedKey (loop exits)
        let page2 = r#"{"Items":[{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"zz99yy88ww"},"version_id":{"N":"1"},"title":{"S":"Found It"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"}}],"Count":1,"ScannedCount":5}"#;
        let client = test_dynamo_client(vec![replay_ok(page1), replay_ok(page2)]);

        let result = handle_search_notes(
            test_state(client),
            Query(SearchNotesParams {
                search_string: "Found".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 1);
        assert_eq!(headers[0]["note_id"], "zz99yy88ww");
        assert_eq!(headers[0]["title"], "Found It");
        assert!(json["continue_key"].is_null());
    }

    #[tokio::test]
    async fn direct_handle_search_notes_pagination_exhausted_no_matches() {
        // Single page: no matches and no LastEvaluatedKey (loop exits immediately)
        let page1 = r#"{"Items":[],"Count":0,"ScannedCount":5}"#;
        let client = test_dynamo_client(vec![replay_ok(page1)]);

        let result = handle_search_notes(
            test_state(client),
            Query(SearchNotesParams {
                search_string: "nothing".to_string(),
                continue_key: None,
            }),
        ).await;

        let Json(json) = result.unwrap();
        let headers = json["note_headers"].as_array().unwrap();
        assert_eq!(headers.len(), 0);
        assert!(json["continue_key"].is_null());
    }

}
