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

impl NoteFormat {
    /// Parse a NoteFormat from its on-disk string representation.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "PlainText" => Ok(NoteFormat::PlainText),
            _ => Err(format!("unknown note format '{s}'")),
        }
    }

    /// Read a NoteFormat from a DynamoDB record's string field.
    pub fn from_record(item: &DynamoDBRecord, field: &str) -> Result<Self, String> {
        Self::parse(&get_s(item, field)?)
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

impl UserType {
    /// Parse a UserType from its on-disk string representation.
    pub fn parse(s: &str) -> Result<Self, String> {
        match s {
            "Admin" => Ok(UserType::Admin),
            "Earlybird" => Ok(UserType::Earlybird),
            _ => Err(format!("unknown user type '{s}'")),
        }
    }

    /// Read a UserType from a DynamoDB record's string field.
    pub fn from_record(item: &DynamoDBRecord, field: &str) -> Result<Self, String> {
        Self::parse(&get_s(item, field)?)
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

/// A token issued to a user as part of the password-reset flow. The
/// `issued_at` timestamp is recorded when the token is generated and is used
/// for both expiration and the resend cooldown.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PasswordResetToken {
    pub issued_at: Timestamp,
    pub token: String,
}

impl PasswordResetToken {
    /// Render to the on-disk form: `<rfc3339-timestamp>|<token>`.
    pub fn to_stored(&self) -> String {
        format!("{}|{}", self.issued_at, self.token)
    }

    /// Parse from the on-disk form. Returns an error message if the stored
    /// value can't be parsed.
    pub fn from_stored(stored: &str) -> Result<Self, &'static str> {
        let mut parts = stored.splitn(2, '|');
        let ts_str = parts.next().ok_or("empty stored token")?;
        let token = parts.next().ok_or("missing separator in stored token")?;
        if token.is_empty() {
            return Err("empty token portion of stored token");
        }
        let issued_at = Timestamp::from_str(ts_str)
            .map_err(|_| "invalid timestamp in stored token")?;
        Ok(PasswordResetToken { issued_at, token: token.to_string() })
    }

    /// Read an optional PasswordResetToken from a DynamoDB record's string field.
    pub fn from_optional_record(item: &DynamoDBRecord, field: &str) -> Result<Option<Self>, String> {
        match get_opt_s(item, field)? {
            None => Ok(None),
            Some(s) => Self::from_stored(&s)
                .map(Some)
                .map_err(|e| e.to_string()),
        }
    }
}

/// A struct for a user.
pub struct User {
    pub user_id: String,
    pub email: String,
    pub password_hash: String,
    pub user_type: UserType,
    pub create_time: Timestamp,
    /// Set when a password-reset email is issued; cleared on successful reset.
    pub password_reset_token: Option<PasswordResetToken>,
}

/// A struct summarizing more-expensive-to-compute detail about a single user.
/// `notes` and `notes_in_trash` count the user's active and soft-deleted notes;
/// `invalid_notes` is the number of the user's notes that could not be
/// parsed (a corrupt record that is excluded from the other tallies);
/// `most_recent_edit` (max modify_time) and `busiest_note` (max version_id) are
/// computed over the active notes only. The two maxes are `None` when the user
/// has no active notes.
pub struct UserDetail {
    pub user_id: String,
    pub notes: u32,
    pub notes_in_trash: u32,
    pub invalid_notes: u32,
    pub most_recent_edit: Option<Timestamp>,
    pub busiest_note: Option<u32>,
}

/// Pairs a user's record with their computed usage detail; the element type of
/// the admin users_detail response.
pub struct FullUserInfo {
    pub user: User,
    pub user_detail: UserDetail,
}

/// A struct for a session.
pub struct Session {
    pub session_id: String,
    pub user_id: String,
    /// When the session was created; drives the absolute lifetime cap.
    pub create_time: Timestamp,
    /// Approximately when the session was last used; drives the sliding idle window.
    /// Refreshed lazily (at most once per day), so it can lag real activity by up to a day.
    pub last_used: Timestamp,
    /// Effective expiry: the earlier of `last_used + idle limit` and `create_time + lifetime`.
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
            format: NoteFormat::from_record(&item, "format")?,
            body: get_s(&item, "body")?,
            undo_stack: get_list_of_string(&item, "undo_stack")?,
            delete_time: get_opt_s(&item, "delete_time")?
                .map(|s| Timestamp::from_str(&s))
                .transpose()?,
        })
    }
}

impl Note {
    /// Build the DynamoDB item for this note. Inverse of the `TryFrom<DynamoDBRecord>`
    /// read path; used by the new-note, edit, and import write paths. `delete_time` is
    /// emitted only when set (the read path treats it as optional).
    pub fn to_item(&self) -> DynamoDBRecord {
        let mut item = DynamoDBRecord::from([
            ("user_id".to_string(), AttributeValue::S(self.user_id.clone())),
            ("note_id".to_string(), AttributeValue::S(self.note_id.clone())),
            ("version_id".to_string(), AttributeValue::N(self.version_id.to_string())),
            ("title".to_string(), AttributeValue::S(self.title.clone())),
            ("create_time".to_string(), AttributeValue::S(self.create_time.to_string())),
            ("modify_time".to_string(), AttributeValue::S(self.modify_time.to_string())),
            ("format".to_string(), AttributeValue::S(self.format.to_string())),
            ("body".to_string(), AttributeValue::S(self.body.clone())),
            ("undo_stack".to_string(), AttributeValue::L(
                self.undo_stack.iter().map(|s| AttributeValue::S(s.clone())).collect()
            )),
        ]);
        if let Some(ref delete_time) = self.delete_time {
            item.insert("delete_time".to_string(), AttributeValue::S(delete_time.to_string()));
        }
        item
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
            format: NoteFormat::from_record(&item, "format")?,
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
            user_type: UserType::from_record(&item, "user_type")?,
            create_time: get_timestamp(&item, "create_time")?,
            password_reset_token: PasswordResetToken::from_optional_record(&item, "password_reset_token")?,
        })
    }
}

/// Convert a User into a JsonValue suitable to return to the caller.
///
/// Unlike most types, we do NOT expose all the fields of User to the JavaScript layer.
/// The password_hash and password_reset_token are sensitive and must not be included;
/// the user_id is not usable by clients and is not included.
impl From<User> for JsonValue {
    fn from(user: User) -> Self {
        json!({
            "email": user.email,
            "user_type": user.user_type.to_string(),
            "create_time": user.create_time,
        })
    }
}

/// Convert a UserDetail into a JsonValue suitable to return to the caller.
///
/// As with `User`, the `user_id` is not usable by clients and is not included.
/// `most_recent_edit` and `busiest_note` serialize to `null` when the user has
/// no active notes.
impl From<UserDetail> for JsonValue {
    fn from(user_detail: UserDetail) -> Self {
        json!({
            "notes": user_detail.notes,
            "notes_in_trash": user_detail.notes_in_trash,
            "invalid_notes": user_detail.invalid_notes,
            "most_recent_edit": user_detail.most_recent_edit,
            "busiest_note": user_detail.busiest_note,
        })
    }
}

/// Convert a FullUserInfo into a JsonValue suitable to return to the caller.
///
/// Unlike the self-service endpoints, the admin view exposes `user_id`. The
/// sensitive fields (`password_hash`, reset token) are still excluded, since
/// they are never part of `From<User>`.
impl From<FullUserInfo> for JsonValue {
    fn from(info: FullUserInfo) -> Self {
        let user_id = info.user.user_id.clone();
        let mut user_json = JsonValue::from(info.user);
        user_json["user_id"] = json!(user_id);
        json!({
            "user": user_json,
            "user_detail": JsonValue::from(info.user_detail),
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
            create_time: get_timestamp(&item, "create_time")?,
            last_used: get_timestamp(&item, "last_used")?,
            expire_time: get_timestamp(&item, "expire_time")?,
        })
    }
}

impl Session {
    /// Build the DynamoDB item for this session. Inverse of the `TryFrom<DynamoDBRecord>`
    /// read path; used by login and the lazy refresh in the `UserSession` extractor.
    pub fn to_item(&self) -> DynamoDBRecord {
        DynamoDBRecord::from([
            ("session_id".to_string(), AttributeValue::S(self.session_id.clone())),
            ("user_id".to_string(), AttributeValue::S(self.user_id.clone())),
            ("create_time".to_string(), AttributeValue::S(self.create_time.to_string())),
            ("last_used".to_string(), AttributeValue::S(self.last_used.to_string())),
            ("expire_time".to_string(), AttributeValue::S(self.expire_time.to_string())),
            ("ttl_expire".to_string(), AttributeValue::N(self.expire_time.unix_timestamp().to_string())),
        ])
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
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
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

    fn make_user_record(extra_fields: &[(&str, AttributeValue)]) -> DynamoDBRecord {
        let mut item: DynamoDBRecord = HashMap::new();
        item.insert("user_id".to_string(), AttributeValue::S("Xq3_mK8~pL".to_string()));
        item.insert("email".to_string(), AttributeValue::S("test@example.com".to_string()));
        item.insert("password_hash".to_string(), AttributeValue::S("hashed_pw".to_string()));
        item.insert("user_type".to_string(), AttributeValue::S("Earlybird".to_string()));
        item.insert("create_time".to_string(), AttributeValue::S("2026-03-01T00:00:00.000000000Z".to_string()));
        for (k, v) in extra_fields {
            item.insert(k.to_string(), v.clone());
        }
        item
    }

    #[test]
    fn test_user_parse_without_password_reset_token() {
        let user = User::try_from(make_user_record(&[])).unwrap();
        assert!(user.password_reset_token.is_none());
    }

    #[test]
    fn test_user_parse_with_password_reset_token() {
        let stored = "2026-03-15T12:00:00Z|abc123";
        let item = make_user_record(&[
            ("password_reset_token", AttributeValue::S(stored.to_string())),
        ]);
        let user = User::try_from(item).unwrap();
        let prt = user.password_reset_token.unwrap();
        assert_eq!(prt.token, "abc123");
        assert_eq!(prt.issued_at, Timestamp::from_str("2026-03-15T12:00:00Z").unwrap());
    }

    #[test]
    fn test_user_parse_with_corrupt_password_reset_token_fails() {
        let item = make_user_record(&[
            ("password_reset_token", AttributeValue::S("garbage-no-separator".to_string())),
        ]);
        assert!(User::try_from(item).is_err());
    }

    #[test]
    fn test_password_reset_token_round_trip() {
        let prt = PasswordResetToken {
            issued_at: Timestamp::from_str("2026-05-03T12:00:00Z").unwrap(),
            token: "abc123_~XYZ".to_string(),
        };
        let stored = prt.to_stored();
        let parsed = PasswordResetToken::from_stored(&stored).unwrap();
        assert_eq!(parsed, prt);
    }

    #[test]
    fn test_password_reset_token_parse_rejects_no_separator() {
        assert!(PasswordResetToken::from_stored("2026-05-03T12:00:00Z").is_err());
    }

    #[test]
    fn test_password_reset_token_parse_rejects_empty_token() {
        assert!(PasswordResetToken::from_stored("2026-05-03T12:00:00Z|").is_err());
    }

    #[test]
    fn test_password_reset_token_parse_rejects_invalid_timestamp() {
        assert!(PasswordResetToken::from_stored("not-a-timestamp|abc").is_err());
    }

    #[test]
    fn test_password_reset_token_parse_rejects_empty_string() {
        assert!(PasswordResetToken::from_stored("").is_err());
    }

    #[test]
    fn test_user_json_excludes_sensitive_fields() {
        let item = make_user_record(&[
            ("password_reset_token", AttributeValue::S("2026-03-15T12:00:00Z|abc123".to_string())),
        ]);
        let user = User::try_from(item).unwrap();
        let value: JsonValue = user.into();
        assert!(value.get("password_hash").is_none());
        assert!(value.get("password_reset_token").is_none());
        assert!(value.get("user_id").is_none());
        assert!(value.get("email").is_some());
    }

    #[test]
    fn test_timestamp_serialize() {
        assert_eq!(
            r#"{"timestamp":"2026-03-09T00:00:00Z"}"#,
            json!({"timestamp": Timestamp::from_str("2026-03-09T00:00:00Z").unwrap()}).to_string()
        );
    }
}
