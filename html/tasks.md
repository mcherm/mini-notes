# Tasks
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
**Path:** /api/v1/notes [GET]

**Inputs:**
* session_id: [header] string

**Outputs:**
xxx
**Description**
Create a new note


### Get Notes Continued
**Path:** /api/v1/notes_more [GET]

### Get Note
**Path:** /api/v1/notes/*{note_id}* [GET]
### Edit Note
**Path:** /api/v1/notes/*{note_id}* [PUT]
### Delete Note
**Path:** /api/v1/notes/*{note_id}* [DELETE]
### Search Notes
**Path:** /api/v1/note_search/*{search_string}* [GET]

**Path:** /api/v1/note_search_more/*{continue_key}* [GET]
