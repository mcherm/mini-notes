# Design Notes

## Data Structures

### Types
I will use 10-digit base-64 (A-Za-z0-9_$) for my IDs.

### User

**Fields:**
* user_id: string
* email: string [restricted character set]
* password: string [restricted character set]
* user_type: enum [earlybird]

### Note
**Fields:**
* user_id: string [alphanumeric]
* note_id: string [alphanumeric]
* version_id: number
* title: string [no newlines]
* create_time: timestamp
* modify_time: timestamp
* format: enum [plain]
* body: string

(In DynamoDB the PK is "user_id" and the sort key is "note_id". I will also generate an LSI where the sort key is "modify_time". The LSI will project the fields that are part of NoteHeader.)

Making it an LSI instead of a GSI gives me immediate consistency (nice) and will be a pain if I ever need to change the contents of the LSI. I'm going with the LSI anyway.

### NoteHeader
**Fields:**
* user_id: string [alphanumeric]
* note_id: string [alphanumeric]
* version_id: number
* title: String [no newlines]
* modify_time: timestamp
* format: enum [plain]

### Session
**Fields:**
* session_id: string
* user_id: string
* expires: date

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

### Sessions
* PK: session_id
* Fields: [the fields of Session]

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

## URLs
I intend to put the production website at https://mini-notes.com . The dev version will be at https://dev.mini-notes.com .
The API endpoints will be at https://api.mini-notes.com for production and https://dev-api.mini-notes.com for dev.
