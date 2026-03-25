use std::collections::HashSet;
use std::io::{Cursor, Write};

use aws_sdk_dynamodb::types::AttributeValue;
use axum::{
    body::Body,
    extract::State,
    http::StatusCode,
    response::Response,
};
use tracing::info;
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::DateTime as ZipDateTime;

use crate::extractors::{AppState, HandlerErrOutput, http_error, UserSession};
use crate::models::{DynamoDBRecord, Note};

const DEFAULT_FILENAME: &str = "mini-notes.zip";

/// Sanitize a note title for use as a filename.
/// Removes: / \ : * ? " < > | NUL and control characters.
/// Truncates to 40 characters, then appends ".txt".
fn sanitize_title(title: &str) -> String {
    const FORBIDDEN: &str = "/\\:*?\"<>|";
    let cleaned: String = title
        .chars()
        .filter(|c| !FORBIDDEN.contains(*c) && *c != '\0' && !c.is_control())
        .collect();
    let truncated: String = cleaned.chars().take(40).collect();
    format!("{truncated}.txt")
}

/// Given a desired filename, return a unique version by appending " (2)", " (3)", etc.
/// if the name is already in `used`. Inserts the result into `used`.
fn deduplicate_filename(name: &str, used: &mut HashSet<String>) -> String {
    if used.insert(name.to_string()) {
        return name.to_string();
    }
    // Strip .txt, add suffix, re-add .txt
    let base = name.strip_suffix(".txt").unwrap_or(name);
    let mut counter = 2;
    loop {
        let candidate = format!("{base} ({counter}).txt");
        if used.insert(candidate.clone()) {
            return candidate;
        }
        counter += 1;
    }
}

/// Parse an ISO8601 timestamp string into a zip::DateTime.
/// Falls back to the current date/time on parse failure (which should never happen
/// since modify_time is always written in the correct format).
fn parse_modify_time_to_zip(iso: &str) -> ZipDateTime {
    fn now_as_zip() -> ZipDateTime {
        let now = time::UtcDateTime::now();
        ZipDateTime::from_date_and_time(
            now.year() as u16, now.month() as u8, now.day(),
            now.hour(), now.minute(), now.second(),
        ).unwrap_or_default()
    }

    // Expected format: "2026-03-10T00:00:00.000000000Z"
    if iso.len() < 19 {
        return now_as_zip();
    }
    let Ok(year) = iso[0..4].parse::<u16>() else { return now_as_zip() };
    let Ok(month) = iso[5..7].parse::<u8>() else { return now_as_zip() };
    let Ok(day) = iso[8..10].parse::<u8>() else { return now_as_zip() };
    let Ok(hour) = iso[11..13].parse::<u8>() else { return now_as_zip() };
    let Ok(minute) = iso[14..16].parse::<u8>() else { return now_as_zip() };
    let Ok(second) = iso[17..19].parse::<u8>() else { return now_as_zip() };

    ZipDateTime::from_date_and_time(year, month, day, hour, minute, second)
        .unwrap_or_else(|_| now_as_zip())
}

/// Fetch all notes for a given user, paginating through DynamoDB until exhausted.
async fn fetch_all_notes(state: &AppState, user_id: &str) -> Result<Vec<Note>, HandlerErrOutput> {
    let mut notes: Vec<Note> = Vec::new();
    let mut exclusive_start_key: Option<DynamoDBRecord> = None;

    loop {
        let result = state.dynamo_client
            .query()
            .table_name(&state.notes_table_name)
            .key_condition_expression("user_id = :uid")
            .expression_attribute_values(":uid", AttributeValue::S(user_id.to_string()))
            .set_exclusive_start_key(exclusive_start_key)
            .send()
            .await;
        let result = match result {
            Ok(response) => response,
            Err(err) => return Err(http_error(500, &err.to_string())),
        };

        exclusive_start_key = result.last_evaluated_key;

        let Ok(new_notes): Result<Vec<Note>, String> = result
            .items.unwrap_or_default()
            .into_iter()
            .map(Note::try_from)
            .collect()
        else {
            return Err(http_error(500, "a note is invalid in DB"));
        };
        notes.extend(new_notes);

        if exclusive_start_key.is_none() {
            break;
        }
    }

    Ok(notes)
}

/// Handler for exporting all of a user's notes as a zip file.
#[axum::debug_handler]
pub async fn handle_export_notes(
    State(state): State<AppState>,
    user_session: UserSession,
) -> Result<Response, HandlerErrOutput> {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    info!(user_id, table = state.notes_table_name, "exporting notes");

    let notes = fetch_all_notes(&state, &user_id).await?;

    // Build the zip file
    let buf = Cursor::new(Vec::new());
    let mut zip = ZipWriter::new(buf);
    let mut used_filenames: HashSet<String> = HashSet::new();

    for note in &notes {
        let raw_filename = sanitize_title(&note.title);
        let filename = deduplicate_filename(&raw_filename, &mut used_filenames);
        let mod_time = parse_modify_time_to_zip(&note.modify_time);
        let options = SimpleFileOptions::default()
            .last_modified_time(mod_time);

        if let Err(err) = zip.start_file(&filename, options) {
            return Err(http_error(500, &format!("zip error: {err}")));
        }
        if let Err(err) = zip.write_all(note.body.as_bytes()) {
            return Err(http_error(500, &format!("zip write error: {err}")));
        }
    }

    let zip_bytes = match zip.finish() {
        Ok(cursor) => cursor.into_inner(),
        Err(err) => return Err(http_error(500, &format!("zip finish error: {err}"))),
    };

    // Build the response with binary zip data
    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", format!("attachment; filename=\"{DEFAULT_FILENAME}\""))
        .body(Body::from(zip_bytes))
        .map_err(|err| http_error(500, &format!("response build error: {err}")))
}


#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use super::*;
    use crate::test_helpers::*;
    use http_body_util::BodyExt;

    // Helper to collect body bytes from the response
    async fn body_bytes(response: Response) -> Vec<u8> {
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec()
    }

    #[tokio::test]
    async fn direct_handle_export_notes_happy_path() {
        let query_response = r#"{"Items":[
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"My First Note"},"create_time":{"S":"2026-03-09T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T12:30:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Hello world"}},
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"zz99yy88ww"},"version_id":{"N":"1"},"title":{"S":"Second Note"},"create_time":{"S":"2026-03-09T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-11T08:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Goodbye world"}}
        ],"Count":2,"ScannedCount":2}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_export_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let response = result.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get("Content-Type").unwrap(),
            "application/zip"
        );
        assert_eq!(
            response.headers().get("Content-Disposition").unwrap(),
            format!("attachment; filename=\"{DEFAULT_FILENAME}\"").as_str()
        );

        // Read the zip and verify contents
        let bytes = body_bytes(response).await;
        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader).unwrap();
        assert_eq!(archive.len(), 2);

        // Collect files into a map for order-independent checking
        let mut files: HashMap<String, String> = HashMap::new();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).unwrap();
            let mut contents = String::new();
            std::io::Read::read_to_string(&mut file, &mut contents).unwrap();
            files.insert(file.name().to_string(), contents);
        }
        assert_eq!(files.get("My First Note.txt").unwrap(), "Hello world");
        assert_eq!(files.get("Second Note.txt").unwrap(), "Goodbye world");
    }

    #[tokio::test]
    async fn direct_handle_export_notes_not_logged_in() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_export_notes(
            test_state(client),
            test_no_user_session(),
        ).await;

        let (status, axum::response::Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn direct_handle_export_notes_empty() {
        let query_response = r#"{"Items":[],"Count":0,"ScannedCount":0}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_export_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let response = result.unwrap();
        assert_eq!(response.status(), StatusCode::OK);

        let bytes = body_bytes(response).await;
        let reader = Cursor::new(bytes);
        let archive = zip::ZipArchive::new(reader).unwrap();
        assert_eq!(archive.len(), 0);
    }

    #[test]
    fn test_sanitize_title_special_chars() {
        assert_eq!(sanitize_title("hello/world"), "helloworld.txt");
        assert_eq!(sanitize_title("a\\b:c*d?e\"f<g>h|i"), "abcdefghi.txt");
        assert_eq!(sanitize_title("normal title"), "normal title.txt");
        assert_eq!(sanitize_title(""), ".txt");
    }

    #[test]
    fn test_sanitize_title_long_title() {
        let long = "a".repeat(50);
        let result = sanitize_title(&long);
        assert_eq!(result, format!("{}.txt", "a".repeat(40)));
    }

    #[test]
    fn test_sanitize_title_control_chars() {
        assert_eq!(sanitize_title("hello\x00world"), "helloworld.txt");
        assert_eq!(sanitize_title("tab\there"), "tabhere.txt");
        assert_eq!(sanitize_title("new\nline"), "newline.txt");
    }

    #[test]
    fn test_deduplicate_filename() {
        let mut used = HashSet::new();
        assert_eq!(deduplicate_filename("note.txt", &mut used), "note.txt");
        assert_eq!(deduplicate_filename("note.txt", &mut used), "note (2).txt");
        assert_eq!(deduplicate_filename("note.txt", &mut used), "note (3).txt");
        assert_eq!(deduplicate_filename("other.txt", &mut used), "other.txt");
    }

    #[tokio::test]
    async fn direct_handle_export_notes_duplicate_titles() {
        let query_response = r#"{"Items":[
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"1"},"title":{"S":"Same Title"},"create_time":{"S":"2026-03-09T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"First"}},
            {"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"zz99yy88ww"},"version_id":{"N":"1"},"title":{"S":"Same Title"},"create_time":{"S":"2026-03-09T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-10T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Second"}}
        ],"Count":2,"ScannedCount":2}"#;
        let client = test_dynamo_client(vec![replay_ok(query_response)]);

        let result = handle_export_notes(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
        ).await;

        let response = result.unwrap();
        let bytes = body_bytes(response).await;
        let reader = Cursor::new(bytes);
        let mut archive = zip::ZipArchive::new(reader).unwrap();
        assert_eq!(archive.len(), 2);

        let mut filenames: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        filenames.sort();
        assert_eq!(filenames, vec!["Same Title (2).txt", "Same Title.txt"]);
    }
}
