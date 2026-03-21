use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use aws_sdk_dynamodb::types::AttributeValue;
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};


// ========== Enums ==========

/// An enum for the various kinds of notes we support. Right now it is ONLY one
/// kind (plain text).
#[derive(Debug, Deserialize)]
pub enum NoteFormat {
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
pub fn parse_note_format(s: &str) -> Result<NoteFormat, String> {
    match s {
        "PlainText" => Ok(NoteFormat::PlainText),
        _ => Err(format!("unknown note format '{s}'")),
    }
}


/// An enum for the various kinds of user we support. Right now it is ONLY one
/// kind ("Earlybird")
#[derive(Debug, Deserialize)]
pub enum UserType {
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
pub fn parse_user_type(s: &str) -> Result<UserType, String> {
    match s {
        "Earlybird" => Ok(UserType::Earlybird),
        _ => Err(format!("unknown user type '{s}'")),
    }
}


// ========== Structs ==========

/// A struct for the contents of a note.
pub struct Note {
    pub user_id: String,
    pub note_id: String,
    pub version_id: u32,
    pub title: String,
    pub create_time: String,
    pub modify_time: String,
    pub format: NoteFormat,
    pub body: String,
}

/// A struct for the header of a note.
pub struct NoteHeader {
    pub user_id: String,
    pub note_id: String,
    pub version_id: u32,
    pub title: String,
    pub modify_time: String,
    pub format: NoteFormat,
}

/// A struct for a user.
pub struct User {
    pub user_id: String,
    pub email: String,
    pub password_hash: String,
    pub user_type: UserType,
    pub create_time: String,
}

/// A struct for a session.
pub struct Session {
    pub session_id: String,
    pub user_id: String,
    pub expire_time: String,
}


// ========== DynamoDB Helpers ==========

pub type DynamoDBRecord = HashMap<String, AttributeValue>;

/// Helper for reading string fields from DynamoDB.
pub fn get_s(item: &DynamoDBRecord, field: &str) -> Result<String, String> {
    item.get(field)
        .ok_or_else(|| format!("missing field '{field}'"))?
        .as_s()
        .map(|s| s.to_string())
        .map_err(|_| format!("field '{field}' is not a string"))
}

/// Helper for reading number fields from DynamoDB.
pub fn get_n_as_u32(item: &DynamoDBRecord, field: &str) -> Result<u32, String> {
    let n_str = item.get(field)
        .ok_or_else(|| format!("missing field '{field}'"))?
        .as_n()
        .map_err(|_| format!("field '{field}' is not a number"))?;
    n_str.parse::<u32>()
        .map_err(|_| format!("field '{field}' is not a valid u32"))
}


// ========== Conversions ==========

/// Convert a DynamoDBRecord (which this consumes) into a Note. Returns an error if the record
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

/// Convert a NoteHeader into a JsonValue suitable to return to the caller.
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
            create_time: get_s(&item, "create_time")?,
        })
    }
}

/// Convert a User into a JsonValue suitable to return to the caller.
///
/// Unlike most types, we do NOT expose all the fields of User to the JavaScript layer.
/// The password_hash is sensitive and should not be included; the user_id is not usable
/// by clients and is not included.
impl From<User> for JsonValue {
    fn from(user: User) -> Self {
        json!({
            "email": user.email,
            "user_type": user.user_type.to_string(),
            "create_time": user.create_time,
        })
    }
}

/// Convert a DynamoDBRecord (which this consumes) into a Session. Returns an error if the record
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

/// Convert a Session into a JsonValue suitable to return to the caller.
impl From<Session> for JsonValue {
    fn from(session: Session) -> Self {
        json!({
            "session_id": session.session_id,
            "user_id": session.user_id,
            "expire_time": session.expire_time,
        })
    }
}
