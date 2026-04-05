use aws_sdk_dynamodb::types::AttributeValue;
use aws_sdk_dynamodb::types::ReturnValue;
use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};
use tracing::info;

use crate::extractors::{AppState, HandlerOutput, HandlerErrOutput, CurrentTime, IdGenerator, http_error, UserSession};
use crate::models::{Note, NoteFormat};
use crate::diff;
use crate::utils::is_valid_id;


const TITLE_PREFIX_FOR_CONFLICTS: &str = "[CONFLICTED] ";

/// A struct for the things that are passed in as part of the body when a note is being modified.
#[derive(Debug, Deserialize)]
pub struct EditNoteBody {
    pub title: String,
    pub body: String,
    pub source_version_id: u32,
}

/// Logic for handling the edit_note command. This modifies a note that already exists.
#[axum::debug_handler]
pub async fn handle_edit_note(
    State(state): State<AppState>,
    user_session: UserSession,
    Path(note_id): Path<String>,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    Json(edit_note_fields): Json<EditNoteBody>,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    if ! is_valid_id(&note_id) {
        return Err(http_error(404, "note_id has invalid characters"));
    }

    let expected_version = edit_note_fields.source_version_id;
    let new_version_id = expected_version + 1;

    info!(user_id, note_id, table = state.notes_table_name, ?edit_note_fields, "updating note");

    // --- Read existing note ---
    let existing_note: Option<Note> = get_existing_note(&state, &note_id, &user_id).await?;

    // --- Bail now if we find that it's not the right version ---
    if let Some(note) = existing_note.as_ref() && note.version_id != edit_note_fields.source_version_id {
        return handle_conflict(
            &state, &user_id, &note_id, &edit_note_fields, &current_time, generate_id, new_version_id,
        ).await;
    }

    // --- Generate diffs ---
    let (title_diff, note_diff) = match existing_note {
        None => (None, None),
        Some(note) => (
            diff::diff(&note.title, &edit_note_fields.title),
            diff::diff(&note.body, &edit_note_fields.body)
        ),
    };

    info!(title_diff, note_diff, "Reviewing diffs for a note");

    // --- Attempt conditional update ---
    let result = state.dynamo_client
        .update_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .update_expression("SET title = :t, body = :b, modify_time = :m, version_id = :v")
        .condition_expression("version_id = :expected_version")
        .expression_attribute_values(":t", AttributeValue::S(edit_note_fields.title.clone()))
        .expression_attribute_values(":b", AttributeValue::S(edit_note_fields.body.clone()))
        .expression_attribute_values(":m", AttributeValue::S(current_time.time_string.clone()))
        .expression_attribute_values(":v", AttributeValue::N(new_version_id.to_string()))
        .expression_attribute_values(":expected_version", AttributeValue::N(expected_version.to_string()))
        .return_values(ReturnValue::AllNew)
        .send()
        .await;

    match result {
        Ok(output) => {
            // --- Success: parse returned attributes into a Note ---
            let attributes = output.attributes
                .ok_or_else(|| http_error(500, "update succeeded but returned no attributes"))?;
            let updated_note = Note::try_from(attributes)
                .map_err(|err| http_error(500, &format!("updated note is invalid: {err}")))?;
            let note_json: JsonValue = updated_note.into();
            let body_json = json!({"note": note_json});
            Ok(Json(body_json))
        }
        Err(sdk_err) => {
            // Check if this is a ConditionalCheckFailedException
            if sdk_err.as_service_error()
                .map(|e| e.is_conditional_check_failed_exception())
                .unwrap_or(false)
            {
                // --- Conflict detected: check if note still exists ---
                handle_conflict(
                    &state, &user_id, &note_id, &edit_note_fields, &current_time, generate_id, new_version_id,
                ).await
            } else {
                Err(http_error(500, &sdk_err.to_string()))
            }
        }
    }
}

/// Looks for an existing note in the database. Returns a HandlerErrOutput if accessing the database
/// fails, Ok(None) if it succeeds but there is no note, and Ok(Some(Note)) if there IS an existing
/// note.
async fn get_existing_note(state: &AppState, note_id: &String, user_id: &String)
    -> Result<Option<Note>, HandlerErrOutput>
{
    let result = state.dynamo_client.get_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await;
    match result {
        Err(err) => Err(http_error(500, &err.to_string())),
        Ok(response) => match response.item {
            Some(item) => match Note::try_from(item) {
                Err(err) => {
                    info!(err, "note is invalid in DB");
                    Err(http_error(500, "note is invalid in DB"))
                }
                Ok(note) => Ok(Some(note)), // there was an existing note
            }
            None => Ok(None), // there wasn't a note
        }
    }
}

/// Handles the conflict case after a ConditionalCheckFailedException.
/// Checks if the original note still exists to distinguish true edit conflicts from delete-edit conflicts.
async fn handle_conflict(
    state: &AppState,
    user_id: &str,
    note_id: &str,
    edit_note_fields: &EditNoteBody,
    current_time: &CurrentTime,
    generate_id: fn() -> String,
    new_version_id: u32,
) -> HandlerOutput {
    let check_result = state.dynamo_client
        .get_item()
        .table_name(&state.notes_table_name)
        .key("user_id", AttributeValue::S(user_id.to_string()))
        .key("note_id", AttributeValue::S(note_id.to_string()))
        .send()
        .await
        .map_err(|err| http_error(500, &err.to_string()))?;

    if let Some(item) = check_result.item {
        // --- True edit conflict: create a new conflict note ---
        let existing_note = Note::try_from(item)
            .map_err(|err| http_error(500, &format!("existing note is invalid: {err}")))?;
        let conflict_note_id = generate_id();
        let conflict_title = format!("{}{}", TITLE_PREFIX_FOR_CONFLICTS, edit_note_fields.title);

        info!(conflict_note_id, conflict_title, "edit conflict detected, creating conflict note");

        let conflict_note = Note {
            user_id: user_id.to_string(),
            note_id: conflict_note_id,
            version_id: new_version_id,
            title: conflict_title,
            create_time: existing_note.create_time,
            modify_time: current_time.time_string.clone(),
            format: existing_note.format,
            body: edit_note_fields.body.clone(),
        };

        write_note(state, &conflict_note).await?;

        let note_json: JsonValue = conflict_note.into();
        let body_json = json!({"note": note_json});
        Err((StatusCode::CONFLICT, Json(body_json)))
    } else {
        // --- Delete-edit conflict: re-create the note at the original note_id ---
        info!(note_id, "delete-edit conflict detected, re-creating note");

        let restored_note = Note {
            user_id: user_id.to_string(),
            note_id: note_id.to_string(),
            version_id: new_version_id,
            title: edit_note_fields.title.clone(),
            create_time: current_time.time_string.clone(), // we don't know the true create_time so use this
            modify_time: current_time.time_string.clone(),
            format: NoteFormat::PlainText, // we don't know the true format, but for NOW there IS only one
            body: edit_note_fields.body.clone(),
        };

        write_note(state, &restored_note).await?;

        let note_json: JsonValue = restored_note.into();
        let body_json = json!({"note": note_json});
        Ok(Json(body_json))
    }
}

/// Writes a Note to DynamoDB via put_item.
async fn write_note(state: &AppState, note: &Note) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    state.dynamo_client
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
        .await
        .map_err(|err| http_error(500, &err.to_string()))?;
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::routing::put;
    use axum::Router;
    use crate::extractors::IdGenerator;
    use crate::test_helpers::*;

    fn fake_id() -> String { "CONFLICT_ID".to_string() }

    #[tokio::test]
    async fn test_handle_edit_note_updates_existing_note() {
        use tower::ServiceExt;
        use http_body_util::BodyExt;

        // Canned DynamoDB responses: session lookup, UpdateItem (success with AllNew)
        let session_response = r#"{"Item":{"session_id":{"S":"test-session-id"},"user_id":{"S":"Xq3_mK8~pL"},"expire_time":{"S":"2099-12-31T00:00:00.000000000Z"}}}"#;
        let update_item_response = r#"{"Attributes":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"4"},"title":{"S":"New Title"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-15T12:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"New body"}}}"#;

        let client = test_dynamo_client(vec![
            replay_ok(session_response),
            replay_ok(update_item_response),
        ]);

        let app = Router::new()
            .route("/api/v1/notes/{note_id}", put(handle_edit_note))
            .with_state(test_state(client).0);

        let request = axum::http::Request::builder()
            .method("PUT")
            .uri("/api/v1/notes/ab12cd34ef")
            .header("content-type", "application/json")
            .header("cookie", "session_id=test-session-id")
            .body(axum::body::Body::from(r#"{"title":"New Title","body":"New body","source_version_id":3}"#))
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

    #[tokio::test]
    async fn direct_handle_edit_note_happy_path() {
        let update_response = r#"{"Attributes":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"4"},"title":{"S":"New Title"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-15T12:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"New body"}}}"#;
        let client = test_dynamo_client(vec![
            replay_ok(update_response),
        ]);

        let result = handle_edit_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(EditNoteBody {
                title: "New Title".to_string(),
                body: "New body".to_string(),
                source_version_id: 3,
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
    async fn direct_handle_edit_note_conflict() {
        // ConditionalCheckFailedException, then GetItem finds existing note (with someone else's edits), then PutItem for conflict note
        let get_item_response = r#"{"Item":{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"ab12cd34ef"},"version_id":{"N":"5"},"title":{"S":"Someone Else's Title"},"create_time":{"S":"2026-03-01T00:00:00.000000000Z"},"modify_time":{"S":"2026-03-14T00:00:00.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Someone else's body"}}}"#;
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_conditional_check_failed(),
            replay_ok(get_item_response),
            replay_ok(put_response),
        ]);

        let result = handle_edit_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(EditNoteBody {
                title: "My Edit".to_string(),
                body: "My content".to_string(),
                source_version_id: 3,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::CONFLICT);
        assert_eq!(json["note"]["note_id"], "CONFLICT_ID");
        assert_eq!(json["note"]["version_id"], 4);
        assert_eq!(json["note"]["title"], "[CONFLICTED] My Edit");
        assert_eq!(json["note"]["body"], "My content");
        assert_eq!(json["note"]["create_time"], "2026-03-01T00:00:00.000000000Z"); // copied from original
        assert_eq!(json["note"]["format"], "PlainText"); // copied from original
    }

    #[tokio::test]
    async fn direct_handle_edit_note_deleted_note() {
        // ConditionalCheckFailedException, then GetItem finds no note, then PutItem to re-create
        let get_item_response = r#"{}"#;
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![
            replay_conditional_check_failed(),
            replay_ok(get_item_response),
            replay_ok(put_response),
        ]);

        let result = handle_edit_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            Path("ab12cd34ef".to_string()),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(EditNoteBody {
                title: "My Edit".to_string(),
                body: "My content".to_string(),
                source_version_id: 3,
            }),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "ab12cd34ef");
        assert_eq!(json["note"]["version_id"], 4);
        assert_eq!(json["note"]["title"], "My Edit");
        assert_eq!(json["note"]["body"], "My content");
    }

    #[tokio::test]
    async fn direct_handle_edit_note_not_logged_in() {
        let client = test_dynamo_client(vec![]);

        let result = handle_edit_note(
            test_state(client),
            test_no_user_session(),
            Path("ab12cd34ef".to_string()),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(EditNoteBody {
                title: "New Title".to_string(),
                body: "New body".to_string(),
                source_version_id: 3,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }
}
