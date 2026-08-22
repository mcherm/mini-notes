/**
 * The local IndexedDB store for note data: a mirror of the user's notes plus a
 * queue of updates not yet delivered to the server. See docs/pwa_design.md
 * ("Note Data Caching" → "Device Data Storage").
 *
 * The file is split into two layers because the tests run under Node, which
 * has no IndexedDB:
 *
 * - `IdbBackend` (and its helpers) own all real IndexedDB plumbing: opening
 *   the database, creating the schema, and exposing promise-based
 *   transactions. It contains no application logic and is exercised only in
 *   the browser.
 * - `NoteStore` holds every operation the app performs on the store, written
 *   against the backend interface below. The tests construct it with an
 *   in-memory fake backend implementing the same interface.
 *
 * ## The backend interface
 *
 * `backend.transaction(storeNames, mode, callback)` runs `callback` inside a
 * single transaction covering the named object stores, with `mode` either
 * "readonly" or "readwrite". The callback receives an object mapping each
 * store name to a store handle, and the returned promise settles when the
 * transaction does: resolving with the callback's return value on commit, or
 * rejecting if the callback threw or the transaction failed — in which case
 * none of its writes took effect.
 *
 * A store handle offers these promise-returning operations (only what
 * `NoteStore` needs):
 *
 * - `get(key)` — the stored value, or undefined
 * - `getAll(limit)` — values in key order: all of them when `limit` is
 *   undefined, otherwise just the first `limit`
 * - `put(value)` — insert or replace; resolves with the value's key
 * - `delete(key)`
 * - `clear()`
 * - `index(name)` — an object offering `count(key)` and `getAll(key)` over
 *   the named index; `getAll` returns matches in primary-key order
 *
 * The callback must only await operations on the handles it was given.
 * IndexedDB commits a transaction as soon as control returns to the event
 * loop with no requests pending, so awaiting anything else (a fetch, a
 * timer) inside the callback would commit the transaction out from under it.
 */

// ========== Schema ==========

const DB_NAME = "mini-notes";
const DB_VERSION = 1;

/** Object store names, exported so the tests' fake backend can share them. */
export const NOTES_STORE = "notes";
export const QUEUE_STORE = "update_queue";

/** The name of the queue store's index over each command's note_id. */
export const QUEUE_NOTE_ID_INDEX = "note_id";

/**
 * The key used by the trivial write in openNoteStore. The "!" is not in the
 * note-id alphabet, so it can never collide with a real note.
 */
const PROBE_NOTE_ID = "!storage-probe";

/**
 * Creates the schema. Runs inside the versionchange transaction of an
 * upgradeneeded event — the only context IndexedDB allows schema changes in.
 */
function createSchema(db) {
    db.createObjectStore(NOTES_STORE, {keyPath: "note_id"});
    const queue = db.createObjectStore(QUEUE_STORE, {
        keyPath: "update_queue_seq",
        autoIncrement: true,
    });
    queue.createIndex(QUEUE_NOTE_ID_INDEX, "note_id");
}

// ========== IndexedDB backend ==========

/** Wraps one IDBRequest as a promise. */
function requestToPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

/** The store-handle side of the backend interface, over one IDBObjectStore. */
class IdbStoreHandle {
    constructor(objectStore) {
        this.objectStore = objectStore;
    }

    get(key) {
        return requestToPromise(this.objectStore.get(key));
    }

    getAll(limit) {
        return requestToPromise(this.objectStore.getAll(undefined, limit));
    }

    put(value) {
        return requestToPromise(this.objectStore.put(value));
    }

    delete(key) {
        return requestToPromise(this.objectStore.delete(key));
    }

    clear() {
        return requestToPromise(this.objectStore.clear());
    }

    index(name) {
        const index = this.objectStore.index(name);
        return {
            count: (key) => requestToPromise(index.count(key)),
            getAll: (key) => requestToPromise(index.getAll(key)),
        };
    }
}

/** The real-IndexedDB implementation of the backend interface. */
class IdbBackend {
    constructor(db) {
        this.db = db;
    }

    transaction(storeNames, mode, callback) {
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(storeNames, mode);
            const handles = {};
            for (const name of storeNames) {
                handles[name] = new IdbStoreHandle(tx.objectStore(name));
            }
            let result;
            let callbackError = null;
            // Run the callback; settle only when the transaction itself
            // settles, since a commit can still fail after the callback's
            // last request succeeds.
            (async () => {
                result = await callback(handles);
            })().catch((e) => {
                callbackError = e;
                try {
                    tx.abort();
                } catch (ignored) {
                    // The transaction had already ended; the abort handler
                    // below (or oncomplete) has the last word.
                }
            });
            tx.oncomplete = () => resolve(result);
            tx.onabort = () => reject(
                callbackError ?? tx.error ?? new Error("IndexedDB transaction aborted"));
        });
    }
}

/** Opens (creating or upgrading if needed) the database and resolves with it. */
function openDatabase() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => createSchema(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

// ========== The note store ==========

/**
 * Every operation the app performs on the local store, written against the
 * backend interface. Construct it with a backend; openNoteStore does this
 * with the real one.
 */
export class NoteStore {
    constructor(backend) {
        this.backend = backend;
    }

    /**
     * Performs a trivial write and removes it again, in one transaction.
     * Feature detection calls this because some environments (notably
     * private-browsing modes) let the database open but fail every write.
     */
    probeWrite() {
        return this.backend.transaction([NOTES_STORE], "readwrite", async (stores) => {
            await stores[NOTES_STORE].put({note_id: PROBE_NOTE_ID});
            await stores[NOTES_STORE].delete(PROBE_NOTE_ID);
        });
    }

    // ----- The mirror -----

    /** Resolves with the mirrored note, or undefined when the note isn't mirrored. */
    getNote(noteId) {
        return this.backend.transaction([NOTES_STORE], "readonly",
            (stores) => stores[NOTES_STORE].get(noteId)
        );
    }

    /** Resolves with every mirrored note, in note_id order. */
    getAllNotes() {
        return this.backend.transaction([NOTES_STORE], "readonly",
            (stores) => stores[NOTES_STORE].getAll(undefined)
        );
    }

    /**
     * Writes a note the server returned into the mirror — unless the queue
     * holds commands for that note, in which case local state is ahead of the
     * server and the stale server copy must not overwrite it. That check is
     * the read barrier (docs/pwa_design.md → "Queue Records and Indexing"),
     * and it shares one transaction with the write so no command can be
     * enqueued between the two. Resolves with true when the note was written,
     * false when the barrier skipped it.
     */
    putNoteFromServer(note) {
        return this.backend.transaction([NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                const queueIndex = stores[QUEUE_STORE].index(QUEUE_NOTE_ID_INDEX);
                if (await queueIndex.count(note.note_id) > 0) {
                    return false;
                }
                await stores[NOTES_STORE].put(note);
                return true;
            }
        );
    }

    /**
     * Removes a note from the mirror because the server no longer has it,
     * subject to the same read barrier as putNoteFromServer. Resolves with
     * true when the note is gone from the mirror, false when the barrier
     * skipped the removal.
     */
    deleteNoteFromServer(noteId) {
        return this.backend.transaction([NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                const queueIndex = stores[QUEUE_STORE].index(QUEUE_NOTE_ID_INDEX);
                if (await queueIndex.count(noteId) > 0) {
                    return false;
                }
                await stores[NOTES_STORE].delete(noteId);
                return true;
            }
        );
    }

    // ----- The update queue -----

    /**
     * Appends a command to the queue. Pass a record shaped
     * {note_id, command_type, payload, source_version_id}; the store assigns
     * the next sequence number, stores it in the record as update_queue_seq,
     * and resolves with it.
     */
    enqueueCommand(command) {
        return this.backend.transaction([QUEUE_STORE], "readwrite",
            (stores) => stores[QUEUE_STORE].put(command)
        );
    }

    /** Resolves with the command at the head of the queue, or null when it is empty. */
    peekCommand() {
        return this.backend.transaction([QUEUE_STORE], "readonly",
            async (stores) => {
                const head = await stores[QUEUE_STORE].getAll(1);
                return head.length > 0 ? head[0] : null;
            }
        );
    }

    /** Removes the command with the given sequence number from the queue. */
    removeCommand(updateQueueSeq) {
        return this.backend.transaction([QUEUE_STORE], "readwrite",
            (stores) => stores[QUEUE_STORE].delete(updateQueueSeq)
        );
    }

    /** Resolves with true when the queue holds any commands for the note. */
    hasQueuedCommands(noteId) {
        return this.backend.transaction([QUEUE_STORE], "readonly",
            async (stores) => {
                const queueIndex = stores[QUEUE_STORE].index(QUEUE_NOTE_ID_INDEX);
                return await queueIndex.count(noteId) > 0;
            }
        );
    }

    /** Resolves with all queued commands for the note, in delivery order. */
    queuedCommandsForNote(noteId) {
        return this.backend.transaction([QUEUE_STORE], "readonly",
            (stores) => stores[QUEUE_STORE].index(QUEUE_NOTE_ID_INDEX).getAll(noteId)
        );
    }

    // ----- The write path -----

    /**
     * Commits one local write: puts the note into the mirror and appends the
     * command to the queue, in a single transaction — the atomic commit the
     * write path requires (docs/pwa_design.md → "The Write Path"). Pass null
     * as the note when there is nothing to mirror (deleting or recovering a
     * note that is not mirrored); the command is then enqueued alone. No
     * read barrier applies here: a local write is deliberately ahead of the
     * server, and the command this appends is exactly what marks it so.
     * Resolves with the update_queue_seq assigned to the command.
     */
    commitLocalWrite(note, command) {
        return this.backend.transaction([NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                if (note !== null) {
                    await stores[NOTES_STORE].put(note);
                }
                return await stores[QUEUE_STORE].put(command);
            }
        );
    }

    /**
     * Completes a command the server accepted: removes it from the queue
     * and writes the note the server returned into the mirror — but only
     * when that was the last queued command for the note. If later commands
     * remain, the mirror already reflects them and the server's older state
     * must not overwrite it (docs/pwa_design.md → "Queue Records and
     * Indexing", use case 5). Pass null as serverNote when the delivery
     * returned no note; the mirror is then left alone. Resolves with true
     * when the server's note was written, false when it was skipped.
     */
    completeDeliveredCommand(updateQueueSeq, noteId, serverNote) {
        return this.backend.transaction([NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                await stores[QUEUE_STORE].delete(updateQueueSeq);
                if (serverNote === null) {
                    return false;
                }
                const queueIndex = stores[QUEUE_STORE].index(QUEUE_NOTE_ID_INDEX);
                if (await queueIndex.count(noteId) > 0) {
                    return false;
                }
                await stores[NOTES_STORE].put(serverNote);
                return true;
            }
        );
    }

    /**
     * Removes a command that definitively failed, and in the same
     * transaction evicts the note's mirror entry (a no-op when the note is
     * not mirrored): the mirrored state included the failed command's
     * effect, which the server has now refused, so reads must fall back to
     * the server's truth — the normal mechanisms re-fetch it.
     */
    removeFailedCommand(updateQueueSeq, noteId) {
        return this.backend.transaction([NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                await stores[QUEUE_STORE].delete(updateQueueSeq);
                await stores[NOTES_STORE].delete(noteId);
            }
        );
    }

    // ----- Whole-store maintenance -----

    /**
     * Empties the mirror and the queue in one transaction: local note data
     * either all disappears (logout, rejected session) or none of it does.
     */
    wipe() {
        return this.backend.transaction([NOTES_STORE, QUEUE_STORE], "readwrite",
            async (stores) => {
                await stores[NOTES_STORE].clear();
                await stores[QUEUE_STORE].clear();
            }
        );
    }
}

/**
 * Opens the note database and proves it usable with a trivial write.
 * Resolves with a ready NoteStore; throws when IndexedDB is missing or
 * unusable, which is the signal feature detection uses to fall back to
 * online-only mode.
 */
export async function openNoteStore() {
    if (typeof indexedDB === "undefined") {
        throw new Error("IndexedDB is not available in this environment");
    }
    const db = await openDatabase();
    const store = new NoteStore(new IdbBackend(db));
    await store.probeWrite();
    return store;
}
