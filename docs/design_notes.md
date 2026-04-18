# Design Notes

## Data Structures

### Types
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
* password_reset_token: optional string

### Session
**Fields:**
* session_id: string
* user_id: string
* expire_time: date

## Tables

### Notes
* PK: user_id
* SK: note_id
* Fields: [the fields of Note]
* LSI:
  * PK: user_id
  * SK: modify_time

### Users
* PK: user_id
* Fields: [the fields of User]
* GSI (users-by-email):
  * PK: email

### Sessions
* PK: session_id
* Fields: [the fields of Session]

## Commands

| Path                                     | Command                 |
|------------------------------------------|-------------------------|
| `GET    /api/v1/notes`                   | Get Notes               |
| `POST   /api/v1/notes`                   | New Note                |
| `GET    /api/v1/notes/{note_id}`         | Get Note                |
| `PUT    /api/v1/notes/{note_id}`         | Edit Note               |
| `DELETE /api/v1/notes/{note_id}`         | Delete Note             |
| `GET    /api/v1/deleted_notes`           | Get Deleted Notes       |
| `POST   /api/v1/recover_note/{note_id}`  | Recover Deleted Note    |
| `DELETE /api/v1/deleted_notes/{note_id}` | Destroy Deleted Note    |
| `GET    /api/v1/note_export`             | Export Notes            |
| `GET    /api/v1/note_import`             | Import Notes            |
| `GET    /api/v1/note_search`             | Search Notes            |
| `GET    /api/v1/user`                    | Get User                |
| `DELETE /api/v1/user`                    | Delete User             |
| `POST   /api/v1/user`                    | User Edit               |
| `POST   /api/v1/user_login`              | User Login              |
| `POST   /api/v1/user_logout`             | User Logout             |
| `POST   /api/v1/user_create`             | User Create             |
| `POST   /api/v1/pwd_reset/send`          | Send Password Reset     |
| `POST   /api/v1/pwd_reset/change_pwd`    | Complete Password Reset |
| `POST   /api/v1/admin/site_data`         | Site Data               |

### Create User
**Path:** /api/v1/user_create [POST]

**Inputs:**
* email: [body] string [restricted character set]
* password: [body] string [restricted character set]

**Outputs:**
* session_id: [header] string

**Description**
Creates a new user, and a new session for that user (or fails).

### User Login
**Path:** /api/v1/user_login [POST]

**Inputs:**
* email: [body] string
* password: [body] string

**Outputs:**
* session_id: string
* *{sets cookie}*: [header]

**Description**
Ends the current session for a user (if there is one).

### User Logout
**Path:** /api/v1/user_logout [POST]

**Inputs:**
* email: [body] string [restricted character set]
* password: [body] string [restricted character set]

**Outputs:**
* session_id: [header] string

**Description**
Creates a new session for a user (or fails).

### Get User Data (for logged in user)
**Path:** /api/v1/user [GET]

**Inputs:**
* session_id: [header] string

**Outputs:**
* user object fields: [body] object

**Description**
Obtain data about the currently logged-in user.

### Delete User
**Path:** /api/v1/user [DELETE]

**Inputs:**
* session_id: [header] string

`**Outputs:**
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


### New Note
**Path:** /api/v1/notes/ [POST]

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

### Search Notes
**Path:** /api/v1/note_search?search_string=*{search_string}* [GET]\
**Path:** /api/v1/note_search?search_string=*{search_string}*&continue_key=*{continue_key}* [GET]

**Inputs:**
* session_id: [header] string
* search_string: [path] string
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
note is not soft-deleted it returns an 412 error.

### Export Notes
**Path:** /api/v1/note_export?file_format={file_format} [GET]

**Inputs:**
* session_id: [header] string
* format: [query] One of "ziptext" or "json", defaulting to "ziptext"

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
* file: [body] binary

**Outputs:**
* notes_created: [body] number
* notes_updated: [body] number

**Description:**
Accepts a file upload (the raw binary body of the request) containing notes to import.
Several different formats are permitted; if the content is not recognized as one of the
supported formats then a 400 error is returned.

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

### Send Password Reset
**Path:** /api/v1/pwd_reset/send [POST]

**Inputs:**
* email: [body] string

**Outputs:**
* None (returns a 204 on success)

**Description:**
This can be performed without a logged-in session. The caller passes the email of a user for
which they want to perform a password reset. If that user exists, the system will attempt to
send an email with a reset token. This is rate limited: if a password reset has been sent
for this user within a very short period, it will not send another one.


### Complete Password Reset
**Path:** /api/v1/pwd_reset/change_pwd [POST]

**Inputs:**
* user_id: [body] string
* token: [body] string
* new_password: [body] string

**Outputs:**
* None (returns a 204 on success)

**Description:**
This can be performed without a logged-in session. The caller passes the user_id (not email) of
a particular user, the token that was generated by a previous call to the Send Password Reset
API, and a new password to use. If the token provided is, indeed, the most recently issued
token for that user and the token has not yet expired then the password will be changed. In all
other cases, this returns a 401. A succesful update will change the password and will also
disable the token. (Note: as stateless way to protect against excessive calls to this service,
an unsuccessful call to this has a chance to disable the token.)


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
