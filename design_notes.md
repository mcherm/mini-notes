# Design Notes

## Data Structures

### User

**Fields:**
* user_id: string
* email: string [restricted character set]
* password: string [restricted character set]
* user_type: enum [earlybird]

### Note
**Fields:**
* title: string [no newlines]
* body: string
* format: enum [plain]

### NoteHeader
**Fields:**
* title: String [no newlines]
* format: enum [plain]

### Session
**Fields:**
* session_id: string
* user_id: string
* expires: date

## Commands

### Create User
**Path:** /api/v1/user_create [POST]

**Inputs:**
* email: [body] string [restricted character set]
* password: [body] string [restricted character set]

**Outputs:**
* session_id: [header] string

**Description**
Creates a new user, and a new session for that user (or fails).

### Login
**Path:** /api/v1/user_login [POST]

**Inputs:**
* email: [body] string [restricted character set]
* password: [body] string [restricted character set]

**Outputs:**
* session_id: [header] string

**Description**
Creates a new session for a user (or fails).

### Get User Data *[MAY NOT BE NEEDED FOR NOW]*
**Path:** /api/v1/users/*{user_id}* [GET]

**Inputs:**
* session_id: [header] string
* user_id: [path] string

**Outputs:**
* user object fields: [body] object

**Description**
Obtain data about a user.

### New Note
**Path:** /api/v1/notes/ [POST]

**Inputs:**
* session_id: [header] string
* title: [body] string
* body: [body] string
* format: [body] enum

**Outputs:**

**Description**
Create a new note

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

**Outputs:**
* note object: [body] object

**Description:**
Accepts in the body all of the editable fields of the note_id. If non-editable
fields like last-modified are provided they will be silently ignored. It updates
the note to match this new value.

**Design Note:**
In the future we might want to find a way for the caller to specify a version ID
it was based on, to address issues of edit collisions. Save that work for later.


### Delete Note
**Path:** /api/v1/notes/*{note_id}* [DELETE]

**Inputs:**
* session_id: [header] string
* note_id: [path] string

**Outputs:**

**Description:**
Deletes the given note.

### Search Notes
**Path:** /api/v1/note_search/*{search_string}* [GET]\
**Path:** /api/v1/note_search/*{search_string}*?continue_key={continue_key} [GET]

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

## URLs
I intend to put the production website at https://mini-notes.com . The dev version will be at https://dev.mini-notes.com .
The API endpoints will be at https://api.mini-notes.com for production and https://dev-api.mini-notes.com for dev.
