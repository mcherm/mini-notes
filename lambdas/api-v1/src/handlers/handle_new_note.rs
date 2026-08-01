use aws_sdk_dynamodb::operation::put_item::PutItemError;
use aws_sdk_dynamodb::types::ReturnValuesOnConditionCheckFailure;
use axum::{
    extract::State,
    response::Json,
};
use serde::Deserialize;
use serde_json::{json, value::Value as JsonValue};
use tracing::{info, warn, error};

use crate::extractors::{AppState, HandlerOutput, CurrentTime, IdGenerator, http_error, UserSession};
use crate::handlers::common::{verify_size, SERVER_ERROR_MESSAGE};
use crate::models::{Note, NoteFormat};
use crate::utils::is_valid_id;

/// A struct for the things that are passed in as part of the body when a new note is created.
#[derive(Debug, Deserialize)]
pub struct NewNoteBody {
    pub note_id: Option<String>,
    pub title: String,
    pub body: String,
    pub format: NoteFormat,
}

/// Logic for handling the new_note command.
#[axum::debug_handler]
pub async fn handle_new_note(
    State(state): State<AppState>,
    user_session: UserSession,
    current_time: CurrentTime,
    IdGenerator(generate_id): IdGenerator,
    Json(new_note_fields): Json<NewNoteBody>,
) -> HandlerOutput {
    let Some(session) = user_session.0 else {
        return Err(http_error(401, "not logged in"));
    };
    let user_id = session.user_id;

    let (note_id, id_provided): (String, bool) = match new_note_fields.note_id.as_ref() {
        Some(provided_note_id) => {
            if !is_valid_id(provided_note_id) {
                return Err(http_error(400, "Invalid note id"));
            }
            (provided_note_id.clone(), true)
        }
        None => {
            (generate_id(), false)
        }
    };

    info!(user_id, note_id, table = state.notes_table_name, ?new_note_fields, "creating note");

    if let Err(err_msg) = verify_size(&new_note_fields.title, &new_note_fields.body) {
        return Err(http_error(400, err_msg.as_str()));
    }

    let note: Note = Note {
        user_id: user_id.to_string(),
        note_id,
        version_id: 0,
        title: new_note_fields.title,
        create_time: current_time.timestamp,
        modify_time: current_time.timestamp,
        format: new_note_fields.format,
        body: new_note_fields.body,
        undo_stack: Vec::new(),
        delete_time: None,
    };

    let result = state.dynamo_client
        .put_item()
        .table_name(&state.notes_table_name)
        .set_item(Some(note.to_item()))
        .condition_expression("attribute_not_exists(user_id)")
        .return_values_on_condition_check_failure(ReturnValuesOnConditionCheckFailure::AllOld)
        .send()
        .await;

    match result {
        Ok(_) => {
            let note_json: JsonValue = note.into();
            let body_json = json!({"note": note_json});
            Ok(Json(body_json))
        }
        Err(sdk_err) => {
            match sdk_err.as_service_error() {
                Some(PutItemError::ConditionalCheckFailedException(e)) => {
                    if id_provided {
                        // User provided a non-unique ID.
                        // First, get the note from the DB

                        let existing_note_attributes = e.item()
                            .ok_or_else(|| {
                                error!(note_id = %note.note_id, "condition failure when note is missing should be impossible");
                                http_error(500, SERVER_ERROR_MESSAGE)
                            })?
                            .clone();
                        let existing_note: Note = match Note::try_from(existing_note_attributes) {
                            Err(err) => {
                                info!(%err, note_id = note.note_id, "note is invalid");
                                return Err(http_error(500, SERVER_ERROR_MESSAGE));
                            }
                            Ok(existing_note) => existing_note
                        };

                        // Now check if the fields match
                        let notes_match = note.note_id == existing_note.note_id
                            && note.format == existing_note.format
                            && note.title == existing_note.title
                            && note.body == existing_note.body;
                        if notes_match {
                            // It was an idempotent call; return the body
                            let existing_note_json: JsonValue = existing_note.into();
                            Ok(Json(json!({"note": existing_note_json})))
                        } else {
                            // It was NOT an idempotent call; tell the caller it was a dupe note_id
                            warn!(dupe_id = note.note_id, "User provided a non-unique ID for a new note");
                            Err(http_error(400, "Provided note_id was a duplicate"))
                        }
                    } else {
                        // Internal system generated
                        error!(dupe_id = note.note_id, "System generated a duplicate ID");
                        Err(http_error(500, SERVER_ERROR_MESSAGE))
                    }
                }
                _ => {
                    info!(%sdk_err, "new note put_item failed");
                    Err(http_error(500, "Unable to create new note"))
                }
            }
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_helpers::*;

    #[tokio::test]
    async fn direct_handle_new_note_generate_id() {
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(put_response)]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: None,
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "TESTID1234");
        assert_eq!(json["note"]["version_id"], 0);
        assert_eq!(json["note"]["title"], "Test Title");
        assert_eq!(json["note"]["create_time"], "2026-03-15T12:00:00Z");
        assert_eq!(json["note"]["modify_time"], "2026-03-15T12:00:00Z");
        assert_eq!(json["note"]["format"], "PlainText");
        assert_eq!(json["note"]["body"], "Test body");
    }

    #[tokio::test]
    async fn direct_handle_new_note_provided_id() {
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(put_response)]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: Some("TESTID4321".to_string()),
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "TESTID4321");
        assert_eq!(json["note"]["version_id"], 0);
        assert_eq!(json["note"]["title"], "Test Title");
        assert_eq!(json["note"]["create_time"], "2026-03-15T12:00:00Z");
        assert_eq!(json["note"]["modify_time"], "2026-03-15T12:00:00Z");
        assert_eq!(json["note"]["format"], "PlainText");
        assert_eq!(json["note"]["body"], "Test body");
    }

    #[tokio::test]
    async fn direct_handle_new_note_invalid_provided_id() {
        // The id is the right length, but "$" is not in the id alphabet
        let client = test_dynamo_client(vec![]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: Some("TESTID43$1".to_string()),
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "Invalid note id");
    }

    #[tokio::test]
    async fn direct_handle_new_note_duplicate_id_matching_fields() {
        // The put fails its condition because the note already exists, and the stored note is
        // returned with the failure. Its title, body and format match, so this is a retry of a
        // call that already succeeded: no change is made and the stored note is returned.
        let existing_note = r#"{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"TESTID4321"},"version_id":{"N":"0"},"title":{"S":"Test Title"},"create_time":{"S":"2026-03-15T11:59:58.000000000Z"},"modify_time":{"S":"2026-03-15T11:59:58.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Test body"},"undo_stack":{"L":[]}}"#;
        let client = test_dynamo_client(vec![replay_conditional_check_failed_with_item(existing_note)]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: Some("TESTID4321".to_string()),
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let Json(json) = result.unwrap();
        assert_eq!(json["note"]["note_id"], "TESTID4321");
        assert_eq!(json["note"]["version_id"], 0);
        assert_eq!(json["note"]["title"], "Test Title");
        assert_eq!(json["note"]["format"], "PlainText");
        assert_eq!(json["note"]["body"], "Test body");
        // The times are the stored note's, from the earlier call that succeeded -- not this call's
        assert_eq!(json["note"]["create_time"], "2026-03-15T11:59:58Z");
        assert_eq!(json["note"]["modify_time"], "2026-03-15T11:59:58Z");
    }

    #[tokio::test]
    async fn direct_handle_new_note_duplicate_id_different_fields() {
        // The put fails its condition because a note already exists with this id, but its title
        // and body do not match, so this is a genuine collision rather than a retry
        let existing_note = r#"{"user_id":{"S":"Xq3_mK8~pL"},"note_id":{"S":"TESTID4321"},"version_id":{"N":"0"},"title":{"S":"Different Title"},"create_time":{"S":"2026-03-15T11:59:58.000000000Z"},"modify_time":{"S":"2026-03-15T11:59:58.000000000Z"},"format":{"S":"PlainText"},"body":{"S":"Different body"},"undo_stack":{"L":[]}}"#;
        let client = test_dynamo_client(vec![replay_conditional_check_failed_with_item(existing_note)]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: Some("TESTID4321".to_string()),
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert_eq!(json["error"], "Provided note_id was a duplicate");
    }

    #[tokio::test]
    async fn direct_handle_new_note_not_logged_in() {
        let put_response = r#"{}"#;
        let client = test_dynamo_client(vec![replay_ok(put_response)]);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_no_user_session(),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: None,
                title: "Test Title".to_string(),
                body: "Test body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::UNAUTHORIZED);
        assert_eq!(json["error"], "not logged in");
    }

    #[tokio::test]
    async fn direct_handle_new_note_title_too_long() {
        let client = test_dynamo_client(vec![]);
        let long_title = "x".repeat(crate::handlers::common::MAX_TITLE_LEN + 1);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: None,
                title: long_title,
                body: "Normal body".to_string(),
                format: NoteFormat::PlainText,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("Title too long"));
    }

    #[tokio::test]
    async fn direct_handle_new_note_body_too_long() {
        let client = test_dynamo_client(vec![]);
        let long_body = "x".repeat(crate::handlers::common::MAX_BODY_LEN + 1);

        fn fake_id() -> String { "TESTID1234".to_string() }

        let result = handle_new_note(
            test_state(client),
            test_user_session("Xq3_mK8~pL"),
            current_time_stub("2026-03-15T12:00:00.000000000Z"),
            IdGenerator(fake_id),
            Json(NewNoteBody {
                note_id: None,
                title: "Normal title".to_string(),
                body: long_body,
                format: NoteFormat::PlainText,
            }),
        ).await;

        let (status, Json(json)) = result.unwrap_err();
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST);
        assert!(json["error"].as_str().unwrap().contains("Body too long"));
    }
}
