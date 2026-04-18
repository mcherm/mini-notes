use std::collections::HashMap;
use std::fmt::{Display, Formatter};
use std::ops::Add;
use aws_sdk_dynamodb::types::AttributeValue;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, value::Value as JsonValue};
use time::format_description::well_known::Rfc3339;
use time::UtcDateTime;


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
    Admin,
    Earlybird,
}

impl Display for UserType {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", match self {
            UserType::Admin => "Admin",
            UserType::Earlybird => "Earlybird",
        })
    }
}

/// Helper for reading the enum UserType fields from DynamoDB.
pub fn parse_user_type(s: &str) -> Result<UserType, String> {
    match s {
        "Admin" => Ok(UserType::Admin),
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
    pub create_time: Timestamp,
    pub modify_time: Timestamp,
    pub format: NoteFormat,
    pub body: String,
    pub undo_stack: Vec<String>,
    pub delete_time: Option<Timestamp>,
}

/// A struct for the header of a note.
pub struct NoteHeader {
    pub user_id: String,
    pub note_id: String,
    pub version_id: u32,
    pub title: String,
    pub modify_time: Timestamp,
    pub format: NoteFormat,
}

/// A struct for a user.
pub struct User {
    pub user_id: String,
    pub email: String,
    pub password_hash: String,
    pub user_type: UserType,
    pub create_time: Timestamp,
}

/// A struct for a session.
pub struct Session {
    pub session_id: String,
    pub user_id: String,
    pub expire_time: Timestamp,
}

/// A struct summarizing storage-level statistics about the site's DynamoDB tables.
/// All counts and sizes are approximate; they come from DynamoDB's DescribeTable API,
/// which refreshes these values roughly every six hours.
pub struct SiteData {
    pub user_count: u64,
    pub user_size: u64,
    pub session_count: u64,
    pub session_size: u64,
    pub note_count: u64,
    pub note_size: u64,
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

/// Helper for reading timestamp fields from DynamoDB.
pub fn get_timestamp(item: &DynamoDBRecord, field: &str) -> Result<Timestamp, String> {
    Timestamp::from_str(&get_s(&item, field)?)
}

/// Helper for reading Optional<String> fields from DynamoDB.
pub fn get_opt_s(item: &DynamoDBRecord, field: &str) -> Result<Option<String>, String> {
    match item.get(field) {
        None => Ok(None),
        Some(attr) => attr.as_s()
            .map(|s| Some(s.to_string()))
            .map_err(|_| format!("field '{field}' is not a string")),
    }
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

/// Helper for reading list-of-string fields from DynamoDB.
pub fn get_list_of_string(item: &DynamoDBRecord, field: &str) -> Result<Vec<String>, String> {
    let Some(attr) = item.get(field) else {
        return Ok(Vec::new()); // treat absent field as an empty list
    };
    let list = attr.as_l()
        .map_err(|_| format!("field '{field}' is not a list"))?;
    list.iter()
        .map(|av| av.as_s()
            .map(|s| s.to_string())
            .map_err(|_| format!("field '{field}' contains a non-string element")))
        .collect()
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
            create_time: get_timestamp(&item, "create_time")?,
            modify_time: get_timestamp(&item, "modify_time")?,
            format: parse_note_format(&get_s(&item, "format")?)?,
            body: get_s(&item, "body")?,
            undo_stack: get_list_of_string(&item, "undo_stack")?,
            delete_time: get_opt_s(&item, "delete_time")?
                .map(|s| Timestamp::from_str(&s))
                .transpose()?,
        })
    }
}

/// Convert a Note into a JsonValue suitable to return to the caller.
impl From<Note> for JsonValue {
    fn from(note: Note) -> Self {
        let mut obj = json!({
            "user_id": note.user_id,
            "note_id": note.note_id,
            "version_id": note.version_id,
            "title": note.title,
            "create_time": note.create_time,
            "modify_time": note.modify_time,
            "format": note.format.to_string(),
            "body": note.body,
            "undo_stack": note.undo_stack,
        });
        if let Some(ref delete_time) = note.delete_time {
            obj["delete_time"] = json!(delete_time);
        }
        obj
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
            modify_time: get_timestamp(&item, "modify_time")?,
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
            create_time: get_timestamp(&item, "create_time")?,
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
            expire_time: get_timestamp(&item, "expire_time")?,
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

/// Convert a SiteData into a JsonValue suitable to return to the caller.
impl From<SiteData> for JsonValue {
    fn from(site_data: SiteData) -> Self {
        json!({
            "user_count": site_data.user_count,
            "user_size": site_data.user_size,
            "session_count": site_data.session_count,
            "session_size": site_data.session_size,
            "note_count": site_data.note_count,
            "note_size": site_data.note_size,
        })
    }
}

// ========== Field Types ==========

/// This represents a particular moment in time.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp (UtcDateTime);

impl Timestamp {
    /// Attempt to construct from a string in RFC 3339 format.
    pub fn from_str(rfc3339: &str) -> Result<Self, String> {
        UtcDateTime::parse(rfc3339, &Rfc3339)
            .map(Timestamp)
            .map_err(|_| format!("invalid timestamp '{}'", rfc3339))
    }

    /// Construct from a UtcDateTime object.
    pub fn from_date_time(date_time: UtcDateTime) -> Self {
        Timestamp(date_time)
    }

    /// Return the Unix timestamp (seconds since 1970-01-01T00:00:00Z).
    pub fn unix_timestamp(&self) -> i64 {
        self.0.unix_timestamp()
    }
}

impl Display for Timestamp {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        // Design note: converting to RFC 3339 should always work except for negative
        // years or 5+ digit years. I'm comfortable assuming that will always be true.
        write!(f, "{}", self.0.format(&Rfc3339).expect("date_time should convert to rfc3339"))
    }
}

impl Serialize for Timestamp {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error> where S: Serializer {
        serializer.serialize_str(&self.to_string())
    }
}

impl Add<std::time::Duration> for Timestamp {
    type Output = Self;

    fn add(self, rhs: std::time::Duration) -> Self::Output {
        Timestamp::from_date_time(self.0.add(rhs))
    }
}

// ========== Tests ==========

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_timestamp_parse_short() {
        assert!(Timestamp::from_str("2026-03-09T00:00:00Z").is_ok());
    }

    #[test]
    fn test_timestamp_parse_long() {
        assert!(Timestamp::from_str("2026-03-10T12:30:00.000000000Z").is_ok());
    }

    #[test]
    fn test_timestamp_roundtrip() {
        const TIME_STR: &str = "2026-03-09T00:00:00Z";
        assert_eq!(TIME_STR, Timestamp::from_str(TIME_STR).unwrap().to_string());
    }

    #[test]
    fn test_timestamp_serialize() {
        assert_eq!(
            r#"{"timestamp":"2026-03-09T00:00:00Z"}"#,
            json!({"timestamp": Timestamp::from_str("2026-03-09T00:00:00Z").unwrap()}).to_string()
        );
    }
}
