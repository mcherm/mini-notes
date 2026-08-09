/**
 * An in-memory implementation of the backend interface documented in
 * html/store.js, so NoteStore can be tested under Node, which has no
 * IndexedDB.
 *
 * The fake reproduces the IndexedDB behaviors the store's logic relies on:
 *
 * - values are stored and returned as structured clones, never by reference
 * - getAll returns values in key order, and an index's getAll returns its
 *   matches in primary-key order (numbers sort before strings, as IndexedDB
 *   keys do)
 * - an autoIncrement store assigns the next sequence number and writes it
 *   into the stored record at the keyPath
 * - transactions run one at a time; a callback that throws rolls back every
 *   write it made; writes are refused in "readonly" mode; and a store handle
 *   used after its transaction has finished throws
 */

import { NOTES_STORE, QUEUE_STORE, QUEUE_NOTE_ID_INDEX } from "../html/store.js";

/** The schema of the real database, matching createSchema in store.js. */
const SCHEMA = {
    [NOTES_STORE]: {keyPath: "note_id", autoIncrement: false, indexes: {}},
    [QUEUE_STORE]: {
        keyPath: "update_queue_seq",
        autoIncrement: true,
        indexes: {[QUEUE_NOTE_ID_INDEX]: "note_id"},
    },
};

/** Orders two keys the way IndexedDB orders keys: numbers before strings. */
function compareKeys(a, b) {
    if (typeof a === "number" && typeof b === "number") return a - b;
    if (typeof a === "number") return -1;
    if (typeof b === "number") return 1;
    return a < b ? -1 : (a > b ? 1 : 0);
}

/**
 * The store-handle side of the backend interface, over one in-memory store.
 * `tracker.finished` is shared with the owning transaction; once it is set,
 * every operation throws, as a real IndexedDB handle would after its
 * transaction ends.
 */
class FakeStoreHandle {
    constructor(store, mode, tracker) {
        this.store = store;
        this.mode = mode;
        this.tracker = tracker;
    }

    checkUsable() {
        if (this.tracker.finished) {
            throw new Error("store handle used after its transaction finished");
        }
    }

    checkWritable() {
        this.checkUsable();
        if (this.mode !== "readwrite") {
            throw new Error("write attempted in a readonly transaction");
        }
    }

    /** The store's [key, value] entries, in key order. */
    sortedEntries() {
        return [...this.store.records.entries()].sort(
            (a, b) => compareKeys(a[0], b[0])
        );
    }

    async get(key) {
        this.checkUsable();
        return structuredClone(this.store.records.get(key));
    }

    async getAll(limit) {
        this.checkUsable();
        const values = this.sortedEntries().map(([, value]) => value);
        const taken = limit === undefined ? values : values.slice(0, limit);
        return structuredClone(taken);
    }

    async put(value) {
        this.checkWritable();
        const {keyPath, autoIncrement} = this.store.config;
        const record = structuredClone(value);
        let key = record[keyPath];
        if (key === undefined) {
            if (!autoIncrement) {
                throw new Error(`value has no key at "${keyPath}"`);
            }
            key = this.store.nextKey;
            this.store.nextKey += 1;
            record[keyPath] = key;
        } else if (autoIncrement && typeof key === "number" && key >= this.store.nextKey) {
            this.store.nextKey = key + 1;
        }
        this.store.records.set(key, record);
        return key;
    }

    async delete(key) {
        this.checkWritable();
        this.store.records.delete(key);
    }

    async clear() {
        this.checkWritable();
        this.store.records.clear();
    }

    index(name) {
        const path = this.store.config.indexes[name];
        if (path === undefined) {
            throw new Error(`no index named "${name}"`);
        }
        const matches = (key) => this.sortedEntries()
            .map(([, value]) => value)
            .filter((value) => value[path] === key);
        return {
            count: async (key) => {
                this.checkUsable();
                return matches(key).length;
            },
            getAll: async (key) => {
                this.checkUsable();
                return structuredClone(matches(key));
            },
        };
    }
}

/** The in-memory implementation of the backend interface. */
export class FakeBackend {
    constructor() {
        this.stores = new Map();
        for (const [name, config] of Object.entries(SCHEMA)) {
            this.stores.set(name, {config: config, records: new Map(), nextKey: 1});
        }
        this.lastTransaction = Promise.resolve();
    }

    transaction(storeNames, mode, callback) {
        const run = () => this.runTransaction(storeNames, mode, callback);
        // Chain onto the previous transaction (whether it committed or not)
        // so transactions never interleave, as IndexedDB guarantees.
        const result = this.lastTransaction.then(run, run);
        this.lastTransaction = result.catch(() => undefined);
        return result;
    }

    async runTransaction(storeNames, mode, callback) {
        const stores = storeNames.map((name) => {
            const store = this.stores.get(name);
            if (store === undefined) {
                throw new Error(`no object store named "${name}"`);
            }
            return store;
        });
        const snapshots = stores.map((store) => ({
            store: store,
            records: new Map(store.records),
            nextKey: store.nextKey,
        }));
        const tracker = {finished: false};
        const handles = {};
        storeNames.forEach((name, i) => {
            handles[name] = new FakeStoreHandle(stores[i], mode, tracker);
        });
        try {
            return await callback(handles);
        } catch (e) {
            for (const snapshot of snapshots) {
                snapshot.store.records = snapshot.records;
                snapshot.store.nextKey = snapshot.nextKey;
            }
            throw e;
        } finally {
            tracker.finished = true;
        }
    }

    /**
     * Test helper, not part of the backend interface: the values in a store,
     * in key order, for asserting on end-state.
     */
    contents(storeName) {
        const store = this.stores.get(storeName);
        const values = [...store.records.entries()]
            .sort((a, b) => compareKeys(a[0], b[0]))
            .map(([, value]) => value);
        return structuredClone(values);
    }
}
