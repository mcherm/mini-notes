/**
 * Generation and application of "diff" strings (the format is documented in
 * docs/design_notes.md).
 *
 * The generating half is the JavaScript counterpart of lambdas/api-v1/src/diff.rs and is
 * deliberately structured the same way, in two layers:
 *   1. findChunks() aligns two strings, producing a list of Equal / Delete / Insert chunks.
 *   2. DiffEncoder turns that list of chunks into the encoded diff string.
 * The two implementations are maintained in parallel and share the test vectors in
 * tests/diff_vectors.json. The applying half (applyStringDiff and applyNoteDiff) has no
 * Rust counterpart, because only the frontend ever applies a diff.
 *
 * Two types are used throughout, and each function below states which of them it takes:
 *   - a "string": an ordinary JavaScript string.
 *   - a "chars array": an array of strings, each holding exactly one Unicode code point,
 *     as produced by Array.from(someString). This is the counterpart of Rust's &[char],
 *     and it is the unit in which the encoded diff counts characters.
 *
 * A chunk boundary always falls between two code points, never inside one. It may fall
 * inside a grapheme cluster, so a diff can delete a combining mark or an emoji modifier on
 * its own; such a diff still applies exactly, and diff.rs behaves the same way.
 */

// ========== Chunks ==========

/**
 * The alignment of two strings is expressed as a list of chunks, each of which is an object
 * {kind: "equal" | "delete" | "insert", text: string}. Reading the "equal" and "delete"
 * chunks in order reconstructs the first string; reading the "equal" and "insert" chunks in
 * order reconstructs the second.
 *
 * Each of these takes a chars array and returns a chunk whose text is a string.
 */
function equalChunk(chars) { return {kind: "equal", text: chars.join("")}; }
function deleteChunk(chars) { return {kind: "delete", text: chars.join("")}; }
function insertChunk(chars) { return {kind: "insert", text: chars.join("")}; }

/**
 * Collects chunks, merging any chunk into the preceding one when they are the same kind.
 * The encoder requires that no two chunks of the same kind are ever adjacent, and merging
 * on the way in makes that true by construction rather than by an argument about the
 * recursion in splitMiddle(). Empty chunks are dropped.
 */
class ChunkList {
    constructor() {
        /** The chunks collected so far: an array of chunk objects. */
        this.chunks = [];
    }

    /** Adds one chunk object. */
    push(chunk) {
        if (chunk.text === "") {
            return;
        }
        const last = this.chunks[this.chunks.length - 1];
        if (last !== undefined && last.kind === chunk.kind) {
            last.text += chunk.text;
        } else {
            this.chunks.push(chunk);
        }
    }
}

// ========== Finding chunks ==========

/**
 * The shortest run of characters that may be used as an anchor (see findAnchor). Runs
 * shorter than this are not searched for at all: in a body of prose, a common run of only
 * a few characters is usually a coincidence rather than a sign that the surrounding text
 * corresponds, and anchoring on one produces a diff scattered into unreadable fragments.
 */
const ANCHOR_LENGTH = 8;

/**
 * The largest number of positions recorded for any one starting sequence. A note holding
 * many copies of the same text would otherwise make the anchor search quadratic; past this
 * many repeats, later positions are ignored and the anchor found may not be the longest.
 */
const MAX_ANCHOR_CANDIDATES = 32;

/**
 * Aligns two strings, returning an array of chunk objects.
 *
 * Takes two strings; returns an array of chunks.
 */
export function findChunks(s1, s2) {
    const chunkList = new ChunkList();
    // Array.from() on a string yields one element per Unicode code point, never one per
    // UTF-16 code unit, and this is guaranteed by the language specification rather than
    // being an implementation detail: Array.from (ECMA-262 sec 23.1.2.1) dispatches to the
    // string iterator, which "iterates over the code points of a String value" (sec
    // 22.1.3.36) by advancing through the string by CodePointAt's [[CodeUnitCount]] --
    // which is 2 for a surrogate pair and 1 otherwise (sec 11.1.4). So an astral character
    // such as an emoji arrives as one element (itself a two-code-unit string), and the
    // character counts written into the encoded diff are code point counts, the same unit
    // Rust's str::chars() produces.
    diffRange(Array.from(s1), Array.from(s2), chunkList);
    return chunkList.chunks;
}

/**
 * Aligns two chars arrays, appending the resulting chunks to chunkList. Any common prefix
 * and common suffix are peeled off as "equal" chunks and the differing middle is handed to
 * splitMiddle().
 *
 * Takes two chars arrays and a ChunkList; returns nothing.
 */
function diffRange(a, b, chunkList) {
    const prefixLen = commonPrefixLength(a, b);
    chunkList.push(equalChunk(a.slice(0, prefixLen)));
    a = a.slice(prefixLen);
    b = b.slice(prefixLen);

    const suffixLen = commonSuffixLength(a, b);
    const suffix = a.slice(a.length - suffixLen);

    splitMiddle(a.slice(0, a.length - suffixLen), b.slice(0, b.length - suffixLen), chunkList);

    chunkList.push(equalChunk(suffix));
}

/**
 * Aligns two chars arrays that have no common prefix and no common suffix. It looks for a
 * run of characters appearing in both; if it finds one, that run is an "equal" chunk and
 * the text on either side of it is aligned recursively. If it finds none, the two are
 * treated as unrelated: everything in a is deleted and everything in b inserted.
 *
 * Takes two chars arrays and a ChunkList; returns nothing.
 */
function splitMiddle(a, b, chunkList) {
    if (a.length === 0 || b.length === 0) {
        chunkList.push(deleteChunk(a));
        chunkList.push(insertChunk(b));
        return;
    }

    const anchor = findAnchor(a, b);
    if (anchor === null) {
        chunkList.push(deleteChunk(a));
        chunkList.push(insertChunk(b));
        return;
    }

    diffRange(a.slice(0, anchor.aStart), b.slice(0, anchor.bStart), chunkList);
    chunkList.push(equalChunk(a.slice(anchor.aStart, anchor.aStart + anchor.length)));
    diffRange(a.slice(anchor.aStart + anchor.length), b.slice(anchor.bStart + anchor.length), chunkList);
}

/**
 * Finds a long run of characters that appears in both a and b.
 *
 * Every position in a is indexed by the ANCHOR_LENGTH characters starting there; b is then
 * scanned for positions whose starting characters are in that index. Each such hit is
 * extended as far as it will go in both directions, and the longest result wins. This costs
 * time proportional to the length of the two inputs instead of to their product, which
 * matters because the inputs can be whole notes.
 *
 * The run returned is the longest one *discoverable this way*, which is not necessarily the
 * longest run the two strings have in common: a longer run could be missed if its starting
 * characters repeat more than MAX_ANCHOR_CANDIDATES times. Runs shorter than ANCHOR_LENGTH
 * are invisible by design.
 *
 * Takes two chars arrays; returns either null (if there is no common run of at least
 * ANCHOR_LENGTH characters) or an object {aStart, bStart, length} whose fields are indexes
 * into a, indexes into b, and a count of characters.
 */
function findAnchor(a, b) {
    if (a.length < ANCHOR_LENGTH || b.length < ANCHOR_LENGTH) {
        return null;
    }

    // Maps a string of ANCHOR_LENGTH code points to an array of indexes into a.
    const positionsByStart = new Map();
    for (let i = 0; i + ANCHOR_LENGTH <= a.length; i++) {
        const start = a.slice(i, i + ANCHOR_LENGTH).join("");
        const positions = positionsByStart.get(start);
        if (positions === undefined) {
            positionsByStart.set(start, [i]);
        } else if (positions.length < MAX_ANCHOR_CANDIDATES) {
            positions.push(i);
        }
    }

    let best = null;
    let j = 0;
    while (j + ANCHOR_LENGTH <= b.length) {
        const positions = positionsByStart.get(b.slice(j, j + ANCHOR_LENGTH).join(""));
        if (positions === undefined) {
            j++;
            continue;
        }
        let furthestEnd = j + ANCHOR_LENGTH;
        for (const i of positions) {
            let aStart = i;
            let bStart = j;
            while (aStart > 0 && bStart > 0 && a[aStart - 1] === b[bStart - 1]) {
                aStart--;
                bStart--;
            }
            let aEnd = i + ANCHOR_LENGTH;
            let bEnd = j + ANCHOR_LENGTH;
            while (aEnd < a.length && bEnd < b.length && a[aEnd] === b[bEnd]) {
                aEnd++;
                bEnd++;
            }
            if (best === null || aEnd - aStart > best.length) {
                best = {aStart: aStart, bStart: bStart, length: aEnd - aStart};
            }
            furthestEnd = Math.max(furthestEnd, bEnd);
        }
        // Positions inside a run already matched can only yield shorter runs, so skip past it.
        j = furthestEnd;
    }
    return best;
}

/**
 * Takes two chars arrays; returns the number of characters at the start that they have in
 * common.
 */
function commonPrefixLength(a, b) {
    const maxLen = Math.min(a.length, b.length);
    let len = 0;
    while (len < maxLen && a[len] === b[len]) {
        len++;
    }
    return len;
}

/**
 * Takes two chars arrays; returns the number of characters at the end that they have in
 * common.
 */
function commonSuffixLength(a, b) {
    const maxLen = Math.min(a.length, b.length);
    let len = 0;
    while (len < maxLen && a[a.length - 1 - len] === b[b.length - 1 - len]) {
        len++;
    }
    return len;
}

// ========== Encoding chunks ==========

/** Escape a string. Takes a string; returns a string. */
function escapeStr(s) {
    if (!/[\]|\\]/.test(s)) {
        return s;
    }
    let escaped = "";
    for (const c of s) {
        if (c === "]" || c === "|" || c === "\\") {
            escaped += "\\";
        }
        escaped += c;
    }
    return escaped;
}

/**
 * An object that is used to convert from a list of chunks to our custom "diff" string
 * format.
 *
 * To use:
 *     const diffEncoder = new DiffEncoder();
 *     for (const chunk of chunks) {
 *         diffEncoder.pushChunk(chunk);
 *     }
 *     const result = diffEncoder.toDiffString();
 */
class DiffEncoder {
    constructor() {
        /** The encoded diff built so far: a string. */
        this.string = "";
        /** Either null, or a chunk object whose kind is "insert" or "delete". */
        this.queued = null;
        /** A boolean. */
        this.prevWasEqual = false;
    }

    /** Call this to add a chunk into the DiffEncoder. Takes a chunk object. */
    pushChunk(chunk) {
        const queued = this.queued;
        if (queued === null) {
            if (chunk.kind === "equal") {
                this.pushEqual(chunk.text);
            } else {
                this.pushQueue(chunk);
            }
        } else if (queued.kind === "insert" && chunk.kind === "delete") {
            this.pushEdit(chunk.text, queued.text);
        } else if (queued.kind === "delete" && chunk.kind === "insert") {
            this.pushEdit(queued.text, chunk.text);
        } else if (queued.kind === "insert" && chunk.kind === "equal") {
            this.pushEdit("", queued.text);
            this.pushEqual(chunk.text);
        } else if (queued.kind === "delete" && chunk.kind === "equal") {
            this.pushEdit(queued.text, "");
            this.pushEqual(chunk.text);
        } else {
            throw new Error(`Two ${chunk.kind} chunks in a row should never happen`);
        }
    }

    /** Add an insert or delete to the queue. Takes a chunk object. */
    pushQueue(newQueued) {
        if (this.queued !== null) {
            throw new Error("Queuing a new chunk when one is queued should never happen");
        }
        this.queued = newQueued;
        this.prevWasEqual = false;
    }

    /**
     * Call this to push an "equal" (a length of undisturbed characters). Also clears the
     * queue. Takes a string.
     */
    pushEqual(s) {
        if (this.prevWasEqual) {
            throw new Error("Two equal sections in a row should never happen");
        }
        // length in CHARACTERS (not bytes, grapheme clusters, or UTF-16 chars)
        this.string += Array.from(s).length.toString();
        this.queued = null;
        this.prevWasEqual = true;
    }

    /**
     * Call this to push an "edit" (a delete / insert pair). Also clears the queue. Takes
     * two strings: the text to delete and the text to insert.
     */
    pushEdit(del, ins) {
        this.string += "[" + escapeStr(del) + "|" + escapeStr(ins) + "]";
        this.queued = null;
        this.prevWasEqual = false;
    }

    /** Call this to apply whatever has been queued but not yet applied to the string. */
    completeQueued() {
        if (this.queued !== null) {
            if (this.queued.kind === "insert") {
                this.pushEdit("", this.queued.text);
            } else {
                this.pushEdit(this.queued.text, "");
            }
        }
        this.prevWasEqual = false;
    }

    /** Returns the encoded diff: a string. */
    toDiffString() {
        this.completeQueued();
        return this.string;
    }
}

/**
 * Take a series of chunks and convert it into an encoded string. Takes an array of chunk
 * objects; returns a string.
 */
function encodeDiff(chunks) {
    const diffEncoder = new DiffEncoder();
    for (const chunk of chunks) {
        diffEncoder.pushChunk(chunk);
    }
    return diffEncoder.toDiffString();
}

// ========== Public interface ==========

/**
 * Called on two strings, returns null if they are identical, or a string representing
 * the diff if they are not.
 */
export function diffStrings(s1, s2) {
    if (s1 === s2) {
        return null;
    }
    return encodeDiff(findChunks(s1, s2));
}

/**
 * Combine a titleDiff and a bodyDiff into a single string representing differences in a
 * note. Each argument is a diff string in the format documented in docs/design_notes.md
 * under "Diff Format" (as produced by diffStrings), or null where that field is unchanged.
 * The result is one of "t:{title-diff}", "b:{body-diff}", or "t:{title-diff}|b:{body-diff}"
 * ("{" and "}" enclose descriptive text; other characters are literal), or null if both
 * arguments were null. This is the form stored in a note's undo_stack, and the form
 * applyNoteDiff() consumes.
 */
export function formatNoteDiff(titleDiff, bodyDiff) {
    if (titleDiff === null && bodyDiff === null) {
        return null;
    } else if (titleDiff === null) {
        return `b:${bodyDiff}`;
    } else if (bodyDiff === null) {
        return `t:${titleDiff}`;
    } else {
        return `t:${titleDiff}|b:${bodyDiff}`;
    }
}

// ========== Applying diffs ==========

/**
 * This applies the given note diff (in the format described by formatNoteDiff) to a note's
 * title and body.
 *
 * Takes an object with "title" and "body" string fields, a note diff string, and a boolean
 * saying whether to reverse the effect of the diff instead of applying it. Returns a new
 * object with "title" and "body" string fields; the argument is not modified.
 */
export function applyNoteDiff(note, diff, reverse) {
    let title = note.title;
    let body = note.body;

    let section = diff;
    while (section.length > 0) {
        const colonPos = section.indexOf(":");
        if (colonPos === -1) break;
        const key = section.substring(0, colonPos);
        const sectionDiff = section.substring(colonPos + 1);

        if (key === "t") {
            const result = applyStringDiff(title, sectionDiff, reverse);
            title = result.asApplied;
            section = result.remaining;
        } else if (key === "b") {
            const result = applyStringDiff(body, sectionDiff, reverse);
            body = result.asApplied;
            section = result.remaining;
        } else {
            break; // unknown key
        }

        // Strip leading '|' separator before next section
        if (section.startsWith("|")) {
            section = section.substring(1);
        }
    }

    return {title: title, body: body};
}

/**
 * This is passed a string and a "diff" in the format described below, and it returns a string made by
 * applying the diff. Alternately, if reverse=true is provided it will reverse the effect of the diff.
 * Actually, it is slightly more complex than that, because instead of being passed a diff, it can be
 * passed a diff followed by a "|" and other characters, and it will return the unparsed portion of
 * the string. So it ACTUALLY returns an object with three fields: "asApplied" (a string with the
 * result of applying the diff to s), "remaining" (a string containing the rest of the diff string
 * that was NOT part of the leading diff), and "appliesCleanly" (a boolean which is true normally, but
 * false if there was an error applying the diff.
 *
 * The format of the diff is a series of entries, where each entry is (1) an 'unedited range', which is
 * a series of 1 or more digits ("0".."9"), or (2) a 'change' which looks like
 * "[{text-to-remove}|{text-to-add}]" (note: "{" and "}" wrap descriptive text, "[", "|", and "]" are
 * literals).
 *
 * An 'unedited range' is interpreted as a number in base 10 and it means that many characters in the
 * original string should be left as-is (starting from the beginning, or wherever the last bit left off).
 * A 'change' expects to find the literal text-to-remove next, and it will remove that and replace it
 * with the text-to-add. Both text-to-remove and text-to-add allow escaped characters: a "\|" means a
 * single "|", a "\]" means a single "]", and a "\\" means a single "\".
 *
 * If at any point, the next bit of text does NOT perfectly match the text-to-remove, then the diff
 * does not apply cleanly. Instead of deleting anything, it will skip forward that many characters and
 * insert the text-to-add. If we reach the end of the source string without reaching the end of the
 * characters in the diff that also means it did not apply cleanly.
 *
 * Notice that a diff can contain a "|" character inside a 'change', and within a text-to-remove or
 * text-to-add if the "|" is preceeded by a "\", but it CANNOT contain a "|" outside of a 'change'.
 * If a "|" is encountered outside of a 'change' then that indicates the end of the diff and the
 * remainder of the diff input (including the "|") are returned in the "remaining" field.
 */
export function applyStringDiff(s, diff, reverse=false) {
    const srcChars = Array.from(s); // split into Unicode code points
    let srcPos = 0;
    let diffPos = 0;
    let asApplied = "";
    let appliesCleanly = true;

    while (diffPos < diff.length) {
        const ch = diff[diffPos];

        if (ch >= "0" && ch <= "9") {
            // Unedited range: read all consecutive digits as a base-10 number
            let numStr = "";
            while (diffPos < diff.length && diff[diffPos] >= "0" && diff[diffPos] <= "9") {
                numStr += diff[diffPos];
                diffPos++;
            }
            const count = parseInt(numStr, 10);
            for (let i = 0; i < count; i++) {
                if (srcPos < srcChars.length) {
                    asApplied += srcChars[srcPos];
                    srcPos++;
                } else {
                    appliesCleanly = false;
                }
            }
        } else if (ch === "[") {
            // Change: parse [text-to-remove|text-to-add]
            diffPos++; // skip '['
            const textToRemove = readEscaped("|");
            const textToAdd = readEscaped("]");

            const expectedText = reverse ? textToAdd : textToRemove;
            const insertText = reverse ? textToRemove : textToAdd;

            // Check if source matches the expected text
            const expectedChars = Array.from(expectedText);
            let matches = true;
            if (srcPos + expectedChars.length > srcChars.length) {
                matches = false;
            } else {
                for (let i = 0; i < expectedChars.length; i++) {
                    if (srcChars[srcPos + i] !== expectedChars[i]) {
                        matches = false;
                        break;
                    }
                }
            }

            if (matches) {
                srcPos += expectedChars.length; // skip the matched text
            } else {
                appliesCleanly = false;
                // Copy over expectedChars.length characters from source, then insert
                const copyCount = Math.min(expectedChars.length, srcChars.length - srcPos);
                for (let i = 0; i < copyCount; i++) {
                    asApplied += srcChars[srcPos];
                    srcPos++;
                }
            }
            asApplied += insertText;
        } else if (ch === "|") {
            // Bare '|' outside a change: end of this diff
            break;
        } else {
            throw new Error(`Invalid diff: unexpected character '${ch}' at position ${diffPos}`);
        }
    }

    // Any remaining source characters
    if (srcPos < srcChars.length) {
        for (let i = srcPos; i < srcChars.length; i++) {
            asApplied += srcChars[i];
        }
        appliesCleanly = false;
    }

    const remaining = diff.substring(diffPos);
    return { asApplied, remaining, appliesCleanly };

    /** Helper: read characters from diff until unescaped terminator, advancing diffPos. */
    function readEscaped(terminator) {
        let result = "";
        while (diffPos < diff.length) {
            const c = diff[diffPos];
            if (c === "\\") {
                diffPos++;
                if (diffPos < diff.length) {
                    const escaped = diff[diffPos];
                    if (escaped !== "\\" && escaped !== "]" && escaped !== "|") {
                        throw new Error(`Invalid diff: unexpected escape sequence '\\${escaped}' at position ${diffPos - 1}`);
                    }
                    result += escaped;
                    diffPos++;
                }
            } else if (c === terminator) {
                diffPos++; // skip the terminator
                return result;
            } else {
                result += c;
                diffPos++;
            }
        }
        return result; // reached end without finding terminator
    }
}
