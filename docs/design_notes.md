# Design Notes

## Data Structures

### IDs
I will use 10-digit base-64 (A-Za-z0-9_$) for my IDs.

### Note
**Fields:**
* user_id: string [alphanumeric]
* note_id: string [alphanumeric]
* version_id: number
* title: string [no newlines]
* create_time: timestamp
* modify_time: timestamp
* format: enum [PlainText]
* body: string
* undo_stack: list[string] a list of diff strings for undo
* delete_time: optional timestamp

(In DynamoDB the PK is "user_id" and the sort key is "note_id". I will also generate an LSI where the sort key is "modify_time". The LSI will project the fields that are part of NoteHeader.)

Making it an LSI instead of a GSI gives me immediate consistency (nice) and will be a pain if I ever need to change the contents of the LSI. I'm going with the LSI anyway.

### NoteHeader
**Fields:**
* user_id: string [alphanumeric]
* note_id: string [alphanumeric]
* version_id: number
* title: String [no newlines]
* modify_time: timestamp
* format: enum [PlainText]

### User
**Fields:**
* user_id: string
* email: string [restricted character set]
* password_hash [salt and hash of password]
* user_type: enum [Admin, Earlybird]
* create_time: timestamp
* password_reset_token: optional PasswordResetToken

### UserDetail
**Fields:**
* user_id: string -- unique user_id for this user
* notes: number -- number of (active) notes this user has
* notes_in_trash: number -- number of notes this user has in the trash
* invalid_notes: number -- number of notes for this user which have internal errors
* most_recent_edit: timestamp -- time of the most recent edit to any of this user's notes
* busiest_note: number -- largest number of times any of this user's notes has been edited

### PasswordResetToken
**Fields:**
* issued_at: timestamp
* token: string [32 chars from the mini-notes ID alphabet]

In DynamoDB this is stored as a single string field on the User in the form
`<rfc3339-timestamp>|<token>` (using a pipe separator).

### Session
**Fields:**
* session_id: string -- a unique ID for the session. Knowing this is a "bearer token" giving access to the user's notes.
* user_id: string -- the user_id of the user this session is for
* expire_time: timestamp -- this is the date at which it will expire regardless of use
* last_used: timestamp -- this is approximately the last time it was used (to within ~24 hrs)

## Tables

### Notes
* PK: user_id
* SK: note_id
* Fields: [the fields of Note]
* LSI:
  * PK: user_id
  * SK: modify_time
  * Projected: delete_time, format, version_id, title

### Users
* PK: user_id
* Fields: [the fields of User]
* GSI (users-by-email):
  * PK: email

### Sessions
* PK: session_id
* Fields: [the fields of Session]

## Commands

| Path                                     | Command                                             |
|------------------------------------------|-----------------------------------------------------|
| `GET    /api/v1/notes`                   | [Get Notes](#get-notes)                             |
| `POST   /api/v1/notes`                   | [New Note](#new-note)                               |
| `GET    /api/v1/notes/{note_id}`         | [Get Note](#get-note)                               |
| `PUT    /api/v1/notes/{note_id}`         | [Edit Note](#edit-note)                             |
| `DELETE /api/v1/notes/{note_id}`         | [Delete Note](#delete-note)                         |
| `GET    /api/v1/deleted_notes`           | [Get Deleted Notes](#get-deleted-notes)             |
| `POST   /api/v1/recover_note/{note_id}`  | [Recover Deleted Note](#recover-deleted-note)       |
| `DELETE /api/v1/deleted_notes/{note_id}` | [Destroy Deleted Note](#destroy-deleted-note)       |
| `GET    /api/v1/note_export`             | [Export Notes](#export-notes)                       |
| `POST   /api/v1/note_import`             | [Import Notes](#import-notes)                       |
| `GET    /api/v1/note_search`             | [Search Notes](#search-notes)                       |
| `GET    /api/v1/user`                    | [Get User](#get-user)                               |
| `GET    /api/v1/user_detail`             | [Get User Detail](#get-user-detail)                 |
| `DELETE /api/v1/user`                    | [Delete User](#delete-user)                         |
| `POST   /api/v1/user`                    | [User Edit](#user-edit)                             |
| `POST   /api/v1/user_login`              | [User Login](#user-login)                           |
| `POST   /api/v1/user_logout`             | [User Logout](#user-logout)                         |
| `POST   /api/v1/user_create`             | [User Create](#user-create)                         |
| `POST   /api/v1/pwd_reset/send`          | [Send Password Reset](#send-password-reset)         |
| `POST   /api/v1/pwd_reset/change_pwd`    | [Complete Password Reset](#complete-password-reset) |
| `GET    /api/v1/admin/site_data`         | [Site Data](#site-data)                             |
| `GET    /api/v1/admin/users_detail`      | [Site Data](#users-detail)                          |

### Get Notes
**Path:** /api/v1/notes [GET]\
**Path:** /api/v1/notes?continue_key={continue_key} [GET]

**Inputs:**
* session_id: [header] string
* continue_key: [query] string

**Outputs:**
* NoteHeader objects: [body] list<object>
* continuation_key: [body] option<string>

**Description:**
Returns a page worth of notes, iterating in the standard order. If no continue_key
is provided then it starts from the beginning; if a continuation_key is provided it
starts where the last call left off. The output includes a continuation_key if
there might be more to retrieve and does not contain one when we've gotten all of
the notes.

### New Note
**Path:** /api/v1/notes [POST]

**Inputs:**
* session_id: [header] string
* title: [body] string
* body: [body] string
* format: [body] enum

**Outputs:**

**Description**
Create a new note. The title of a note cannot be more than 1,000 bytes in UTF-8.
The body of a note cannot be more than 100,000 bytes in UTF-8. Exceeding these
will return a 400 error.

### Get Note
**Path:** /api/v1/notes/*{note_id}* [GET]

**Inputs:**
* session_id: [header] string
* note_id: [path] string

**Outputs:**
* note object: [body] object

**Description:**
Returns all of the fields of a single note.

### Edit Note
**Path:** /api/v1/notes/*{note_id}* [PUT]

**Inputs:**
* session_id: [header] string
* note_id: [path] string
* note object: [body] object
* source_version_id [body] number

**Outputs:**
* note object: [body] object

**Description:**
Accepts in the body all of the editable fields of the note_id. If non-editable
fields like last-modified are provided they will be silently ignored. It updates
the note to match this new value. The source_version_id must be provided; if the
note's current version_id differs from source_version_id, the edit is treated as
a conflict. On conflict, a new note is created with "[CONFLICTED] " prepended to
the title and a version_id of source_version_id + 1, and the response is 409 with
that new note (which has a different note_id). The original note is left untouched.
If the note was deleted (delete-edit conflict), the note is re-created at the
original note_id without the "[CONFLICTED] " prefix, and the response is 200. The
title of a note cannot be more than 1,000 bytes in UTF-8. The body of a note
cannot be more than 100,000 bytes in UTF-8. Exceeding these will return a 400
error. This cannot operate on a soft-deleted note and will return a 403 error if
that is attempted.


### Delete Note
**Path:** /api/v1/notes/*{note_id}* [DELETE]

**Inputs:**
* session_id: [header] string
* note_id: [path] string

**Outputs:**

**Description:**
Deletes the given note.

### Get Deleted Notes
**Path:** /api/v1/deleted_notes [GET]\
**Path:** /api/v1/deleted_notes?continue_key={continue_key} [GET]

**Inputs:**
* session_id: [header] string
* continue_key: [query] string

**Outputs:**
* NoteHeader objects: [body] list<object>
* continuation_key: [body] option<string>

**Description:**
This operates exactly like the Get Notes API except that this returns information
about the notes that are "in the trash" -- that have been soft-deleted but can
still be recovered.


### Recover Deleted Note
**Path:** /api/v1/recover_note/*{note_id}* [POST]

**Inputs:**
* session_id: [header] string
* note_id: [path] string

**Outputs:**

**Description:**
If note_id corresponds to a note in this user's account that has been soft-deleted
but is not yet unrecoverable, then this "recovers" that note, restoring it to being
a regular note.

### Destroy Deleted Note
**Path:** /api/v1/deleted_notes/*{note_id}* [DELETE]

**Inputs:**
* session_id: [header] string
* note_id: [path] string

**Outputs:**
None

**Description:**
If note_id corresponds to a note in this user's account that has been soft-deleted
but is not yet unrecoverable, then this permanently ("hard-") deletes it. If the
note is not soft-deleted it returns a 412 error.

### Export Notes
**Path:** /api/v1/note_export?file_format={file_format} [GET]

**Inputs:**
* session_id: [header] string
* file_format: [query] One of "ziptext" or "json", defaulting to "ziptext"

**Outputs:**
Unlike most of these APIs, this does NOT return a JSON document. Instead, it returns the
content of a file containing the user's notes. There are two formats: "ziptext" is a zip
file which contains the logged-in user's notes as text files. Specifically, the zip file
contains one file for every note. The content of the file is UTF-8 encoded body of the note.
The modify-date of the file is the modify-date of the note. And the title of the note is a
transform of the title. The transform is to: (1) remove any of the following characters:
"/\:*?"<>|" also Nul and any control character; (2) truncate to 40 characters; (3) append
".txt". The second format is "json", which returns a single JSON file containing an object
with a field named "notes" that has a list with an entry for each note. The entry will
have JSON fields for note_id, version_id, title, create_time, modify_time, format, and
body, which are all strings, except version_id.

### Import Notes
**Path:** /api/v1/note_import [POST]

**Inputs:**
* session_id: [header] string
* filename: [query] string
* file: [body] binary

**Outputs:**
* notes_created: [body] number
* notes_updated: [body] number

**Description:**
Accepts a file upload (the raw binary body of the request) containing notes to import.
The `filename` is required; a request that omits it returns a 400 error. Several different
formats are permitted; if the content is not recognized as one of the supported formats
then a 400 error is returned. The `filename` is used as a hint to choose the format: a
name ending in `.json` is read as JSON, and a name ending in `.txt` is read as a single
plain-text note. For any other extension the format is detected from the content of the
file.

For **Mini-Notes JSON format**: the file must match the format produced by the Export
Notes endpoint (an object with a "notes" field containing a list of note objects). Each
note object should have the standard fields, but any of the fields may be omitted. If
the "note_id" field is provided and it matches an existing note belonging to the user,
that note is updated (title, body, and format are overwritten; modify_time is set to
now; version_id is incremented). If the "note_id" does not match an existing note, a new
note is created using the provided note_id. If no "note_id" is provided, a new note is
created with a generated id.

For **zip-of-text-files format**: each `.txt` file in the zip is imported as a new note.
The title is derived from the filename (with the `.txt` extension removed). The body is
the UTF-8-decoded content of the file. Fields other than title and body are set the same
way as the New Note endpoint (create_time and modify_time set to now, version_id set
to 1, format set to "plain"). Files in the zip that do not end in `.txt` are ignored.
Each file always creates a new note, even if a note with the same title already exists.

For **SimpleNote JSON format**: The file should match the format that SimpleNote uses
when outputting in JSON format. Only notes that are NOT in the trash will be imported.

For **plain-text format**: the entire file becomes the body of a single new note. The
title is derived from the filename (with its extension removed). Fields other than title
and body are set the same way as the New Note endpoint. A file that cannot be decoded as
UTF-8 text is rejected with a 400 error.

### Search Notes
**Path:** /api/v1/note_search?search_string=*{search_string}* [GET]\
**Path:** /api/v1/note_search?search_string=*{search_string}*&continue_key=*{continue_key}* [GET]

**Inputs:**
* session_id: [header] string
* search_string: [query] string
* continue_key: [query] string

**Outputs:**
* NoteHeader objects: [body] list<object>
* continuation_key: [body] option<string>

**Description:**
Returns a page worth of notes that contain (in title or body) the search_string,
iterating in the standard order. If no continue_key is provided then it starts from
the beginning; if a continuation_key is provided it starts where the last call left
off. The output includes a continuation_key if there might be more to retrieve and
does not contain one when we've gotten all of the notes that contain the search
string.

### Get User
**Path:** /api/v1/user [GET]

**Inputs:**
* session_id: [header] string

**Outputs:**
* user object fields: [body] object

**Description**
Obtain data about the currently logged-in user. This only returns basic user
information which is not expensive to compute.

### Get User Detail
**Path:** /api/v1/user_detail [GET]

**Inputs:**
* session_id: [header] string

**Outputs:**
* user detail object fields: [body] object

**Description**
Obtain detailed data about the currently logged-in user. Unlike Get User, this
performs some queries that may take longer or be more expensive.

### Delete User
**Path:** /api/v1/user [DELETE]

**Inputs:**
* session_id: [header] string

**Outputs:**
* If successful, this returns a 204 with no body.

**Description:**
This deletes the currently logged-in user, removing all of their notes, any
sessions, and the user entry.

### User Edit
**Path:** /api/v1/user [POST]

**Inputs:**
* session_id: [header] string
* password: [body] string
* new_password: [body] optional string
* new_email: [body] optional string

**Outputs:**
* None (returns a 204 on success)

**Description:**
This allows editing certain fields of the user. The caller must be logged in, and only the
logged-in user can be edited. Editing user fields is sensitive, so the user must provide their
(current) password. They may optionally provide new values for any of the editable fields:
that's new_password to change the password and/or new_email to change the email. No other
fields are editable at this time.

### User Login
**Path:** /api/v1/user_login [POST]

**Inputs:**
* email: [body] string
* password: [body] string

**Outputs:**
* session_id: string
* *{sets cookie}*: [header]

**Description**
Creates a new session for a user (or fails).

### User Logout
**Path:** /api/v1/user_logout [POST]

**Inputs:**
* session_id: [header] string

**Outputs:**
* *{expires cookie}*: [header]

**Description**
Ends the current session for a user (if there is one).

### User Create
**Path:** /api/v1/user_create [POST]

**Inputs:**
* email: [body] string [restricted character set]
* password: [body] string [restricted character set]

**Outputs:**
* session_id: [header] string

**Description**
Creates a new user, and a new session for that user (or fails).

### Send Password Reset
**Path:** /api/v1/pwd_reset/send [POST]

**Inputs:**
* email: [body] string

**Outputs:**
* None (always returns 204 so as not to leak whether an account exists)

**Description:**
This can be performed without a logged-in session. The caller passes the email of a user for
which they want to perform a password reset.

Several conditions cause the endpoint to do nothing further: the email doesn't pass a basic
validity check, no user has that email, the user has an existing reset token issued less than
60 seconds ago (cooldown), or SES rejects the send. In every one of these cases the endpoint
still returns 204 with no body. (Internal errors still return a 500 error.)

When the endpoint does act, a reset token is generated; the user's `password_reset_token` field
is set; SES is used to deliver an email containing a password reset link.


### Complete Password Reset
**Path:** /api/v1/pwd_reset/change_pwd [POST]

**Inputs:**
* user_id: [body] string
* token: [body] string
* new_password: [body] string

**Outputs:**
* None (returns a 204 on success; 400 on invalid password; 401 on any authentication failure)

**Description:**
This can be performed without a logged-in session. The caller passes the user_id (not email)
of a particular user, the token that was generated by a previous call to the Send Password
Reset API, and a new password.

A new_password that fails password validation (currently: must be non-empty) returns 400.
Otherwise, every path that fails to authenticate the request returns the same 401 with the
message `"invalid user_id or token"`. The unified response covers: no user with that
user_id, no stored token on that user, the stored token is past its 3-hour max age, the
provided token doesn't match the stored one, and the conditional update lost a race against
a concurrent send (or another change). Internal errors return 500.

When the token verifies and is fresh: the user's password is changed to the new value and
all existing sessions for the user are deleted. In a race condition, the password will only
be reset once (for a given password token).

**Stateless brute-force defense:** On a mismatch, there is a small chance that the existing
token will be invalidated.  This probabilistically caps the number of guesses an attacker gets
without generating a new token.


### Site Data
**Path:** /api/v1/admin/site_data [GET]

**Inputs:**
* session_id: [header] string

**Outputs:**
* site_data: [body] SiteData

**Description:**
This gives an access error unless the user calling it is of type "Admin". Otherwise, it returns a SiteData
structure. That structure may evolve, but for now it looks like this:

#### SiteData
**Fields:**
* user_count: number -- the approximate number of users
* user_size: number -- the approximate size (in bytes) of the user table
* session_count: number -- the approximate number of sessions
* session_size: number -- the approximate size (in bytes) of the session table
* note_count: number -- the approximate number of notes
* note_size: number -- the approximate size (in bytes) of the note table

### Users Detail
**Path:** /api/v1/admin/users_detail [GET]

**Inputs:**
* session_id: [header] string

**Outputs:**
* users: [body] array(FullUserInfo)
* orphan_note_count: number -- the number of notes that don't have an owner

**Description:**
This returns detailed information about all users on the site. It may take
a bit of time to compute.

#### FullUserInfo
**Fields:**
* user: User
* user_detail: UserDetail


/api/v1/admin/users_detail

## URLs
I intend to put the production website at https://mini-notes.com . The dev version will be at https://dev.mini-notes.com .
The API endpoints will be at https://api.mini-notes.com for production and https://dev-api.mini-notes.com for dev.

## Diff Format

To support undo, we will want to store "diff"s -- a block of text that describes a change to a note. These are
character-based, not line based. I didn't find an existing format that was standard so I invented my own. The format
is as follows:

A block of text containing sections
 * digits: interpret this as a number in base 10 telling some number of characters to leave as-is.
 * [text-to-delete|text-to-insert]: a block defining an edit. "text-to-delete" is expected at this location and should
be deleted, then "text-to-insert" should be inserted. Both text strings are escaped: any "]", "|" or "\" character
will be escaped by placing a "\" in front of it.

## Import/Export of Notes

**Design Ideation**:

First idea is to mimic (more or less) what SimpleNotes does. I will allow the user to export their notes in
the form of a zip file containing a bunch of text files. The content of the text files will be
UTF-8-encoded note content; the filename will be a transform of the title. The transform is to:
(1) remove any of the following characters: "/\:*?"<>|" also Nul and any control character;
(2) truncate to 40 characters; (3) append ".txt".

*Alternative* export as JSON. That way we could preserve data like the modification and creation
times AND the version_id, all of which would be useful for diffing. AND it wouldn't lose any information.

SimpleNote CAN export as JSON (I can do that on my phone) or as text files (I can do that on my mac).
It does NOT have a title (title is simply the first line of the note). SimpleNote's JSON has the
following fields:
 * "id": "039e4b6f11356ac8b53a64556760ed09"
 *  "content": "ING Info\nMy scopia #: 63463\nMy IP: 10.152.82.47 -- 7DK5BP1.ingdirect.com"
 *  "creationDate": "2018-09-22T16:28:20.346Z"
 *  "lastModified": "2018-09-22T16:28:27.721Z"

With the flat text files I can import from most anything and the output is easy to use. Maybe I
generate a zip file with the flat files AND a json file in it. The zip file COULD associate
modification timestamps (in a different format) with the files.

The zip file alone can't support synchronization... it can get close, but there's no way to
uniquely associate a note in one system to another. The JSON file format COULD support synchronization:
it has a modification_date, it has a unique-id; combine it with an id-to-id mapping and you could
build synchronization.

Import is simpler than sync, by quite a bit. We can just create new notes, ignoring anything that
already exists.
