//! Generation of "diff" strings (the format is documented in docs/design_notes.md).
//!
//! This is the Rust counterpart of html/diff.js and needs to be kept in sync with that.
//!It is structured the same in two layers:
//!   1. find_chunks() compares two strings to obtain a list of Equal, Delete, and Insert chunks.
//!   2. DiffEncoder turns that list of chunks into the encoded diff string.
//!
//! The file tests/diff_vectors.json contains a list of test data which is used by the unit
//! tests for both this Rust implementation and the JavaScript implementation.
//!
//! Two types are used throughout, and each function below states which of them it takes:
//!   - a `&str`: an ordinary string.
//!   - a `&[char]`: a slice of Unicode code points, as produced by `s.chars().collect()`.
//!
//! A chunk boundary always falls between two code points, never inside one. It may fall
//! inside a grapheme cluster, so a diff can delete a combining mark or an emoji modifier on
//! its own; such a diff still applies exactly, and diff.js behaves the same way.

use std::collections::HashMap;

// ========== Chunks ==========

/// The alignment of two strings is expressed as a list of chunks. Reading the Equal and
/// Delete chunks in order reconstructs the first string; reading the Equal and Insert chunks
/// in order reconstructs the second.
///
/// A chunk borrows its text from an `&[char]`, so it has lifetime bounds but does not copy
/// any string data.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Chunk<'a> {
    Equal(&'a [char]),
    Delete(&'a [char]),
    Insert(&'a [char]),
}

impl<'a> Chunk<'a> {
    /// The text this chunk holds.
    fn text(&self) -> &'a [char] {
        match *self {
            Chunk::Equal(s) | Chunk::Delete(s) | Chunk::Insert(s) => s,
        }
    }
}

/// Takes a `&[char]`; returns a chunk borrowing it.
fn equal_chunk(chars: &[char]) -> Chunk<'_> { Chunk::Equal(chars) }
fn delete_chunk(chars: &[char]) -> Chunk<'_> { Chunk::Delete(chars) }
fn insert_chunk(chars: &[char]) -> Chunk<'_> { Chunk::Insert(chars) }

/// This is a vec of chunks which is grown by pushing new chunks onto the end.
/// It performs some simplification: empty chunks are removed. It also requires
/// that no two chunks added be the same type (can't have two Equal in a row
/// or two Inserts.
struct ChunkList<'a> {
    chunks: Vec<Chunk<'a>>,
}

impl<'a> ChunkList<'a> {
    fn new() -> Self {
        ChunkList { chunks: Vec::new() }
    }

    /// Adds one chunk.
    fn push(&mut self, chunk: Chunk<'a>) {
        if chunk.text().is_empty() {
            return;
        }
        // The encoder requires that no two chunks of the same kind are ever adjacent, and
        // they cannot be: split_middle() extends every anchor as far as it will go, so the
        // region to either side of one differs from its counterpart at the boundary, and
        // the trailing (or leading) Equal chunk of a recursive call is therefore always
        // empty and dropped above.
        debug_assert!(
            self.chunks.last().is_none_or(
                |last| std::mem::discriminant(last) != std::mem::discriminant(&chunk)),
            "two adjacent chunks of the same kind should never happen",
        );
        self.chunks.push(chunk);
    }
}

// ========== Finding chunks ==========

/// The shortest run of characters that may be used as an anchor (see find_anchor). Runs
/// shorter than this are not searched for at all: in a body of prose, a common run of only
/// a few characters is usually a coincidence rather than a sign that the surrounding text
/// corresponds, and anchoring on one produces a diff scattered into unreadable fragments.
const ANCHOR_LENGTH: usize = 8;

/// The largest number of positions recorded for any one starting sequence. A note holding
/// many copies of the same text would otherwise make the anchor search quadratic; past this
/// many repeats, later positions are ignored and the anchor found may not be the longest.
const MAX_ANCHOR_CANDIDATES: usize = 32;

/// Aligns two `&[char]`, returning a list of chunks that borrow from them.
fn find_chunks<'a>(a: &'a [char], b: &'a [char]) -> Vec<Chunk<'a>> {
    let mut chunk_list = ChunkList::new();
    diff_range(a, b, &mut chunk_list);
    chunk_list.chunks
}

/// Aligns two `&[char]`, appending the resulting chunks to chunk_list. Any common prefix and
/// common suffix are peeled off as Equal chunks and the differing middle is handed to
/// split_middle().
fn diff_range<'a>(a: &'a [char], b: &'a [char], chunk_list: &mut ChunkList<'a>) {
    let prefix_len = common_prefix_length(a, b);
    chunk_list.push(equal_chunk(&a[..prefix_len]));
    let a = &a[prefix_len..];
    let b = &b[prefix_len..];

    let suffix_len = common_suffix_length(a, b);
    let suffix = &a[a.len() - suffix_len..];

    split_middle(&a[..a.len() - suffix_len], &b[..b.len() - suffix_len], chunk_list);

    chunk_list.push(equal_chunk(suffix));
}

/// Aligns two `&[char]` that have no common prefix and no common suffix. It looks for a run
/// of characters appearing in both; if it finds one, that run is an Equal chunk and the text
/// on either side of it is aligned recursively. If it finds none, the two are treated as
/// unrelated: everything in a is deleted and everything in b inserted. The resulting Chunks
/// are added to the ChunkList.
fn split_middle<'a>(a: &'a [char], b: &'a [char], chunk_list: &mut ChunkList<'a>) {
    if a.is_empty() || b.is_empty() {
        // It's OK to push the empty ones because the ChunkList will disregard them
        chunk_list.push(delete_chunk(a));
        chunk_list.push(insert_chunk(b));
        return;
    }

    let Some(anchor) = find_anchor(a, b) else {
        chunk_list.push(delete_chunk(a));
        chunk_list.push(insert_chunk(b));
        return;
    };

    diff_range(&a[..anchor.a_start], &b[..anchor.b_start], chunk_list);
    chunk_list.push(equal_chunk(&a[anchor.a_start..anchor.a_end()]));
    diff_range(&a[anchor.a_end()..], &b[anchor.b_end()..], chunk_list);
}

/// A run of characters found in both strings: indexes into a, indexes into b, and a count of
/// characters. Will always be at least ANCHOR_LENGTH long, but may be longer.
struct Anchor {
    a_start: usize,
    b_start: usize,
    length: usize,
}

impl Anchor {
    fn a_end(&self) -> usize { self.a_start + self.length }
    fn b_end(&self) -> usize { self.b_start + self.length }
}

/// Finds a long run of characters that appears in both a and b.
///
/// Every position in a is indexed by the ANCHOR_LENGTH characters starting there; b is then
/// scanned for positions whose starting characters are in that index. Each such hit is
/// extended as far as it will go in both directions, and the longest result wins. This costs
/// time proportional to the length of the two inputs instead of to their product, which
/// matters because the inputs can be whole notes.
///
/// The run returned is the longest one *discoverable this way*, which is not necessarily the
/// longest run the two strings have in common: a longer run could be missed if its starting
/// characters repeat more than MAX_ANCHOR_CANDIDATES times. Runs shorter than ANCHOR_LENGTH
/// are invisible by design.
fn find_anchor(a: &[char], b: &[char]) -> Option<Anchor> {
    if a.len() < ANCHOR_LENGTH || b.len() < ANCHOR_LENGTH {
        return None;
    }

    // Maps a sequence of ANCHOR_LENGTH characters to the indexes into a where it begins.
    let mut positions_by_start: HashMap<&[char], Vec<usize>> = HashMap::new();
    for i in 0..=(a.len() - ANCHOR_LENGTH) {
        let positions = positions_by_start.entry(&a[i..i + ANCHOR_LENGTH]).or_default();
        if positions.len() < MAX_ANCHOR_CANDIDATES {
            positions.push(i);
        }
    }

    let mut best: Option<Anchor> = None;
    let mut j = 0;
    while j + ANCHOR_LENGTH <= b.len() {
        let Some(positions) = positions_by_start.get(&b[j..j + ANCHOR_LENGTH]) else {
            j += 1;
            continue;
        };
        let mut furthest_end = j + ANCHOR_LENGTH;
        for &i in positions {
            let mut a_start = i;
            let mut b_start = j;
            while a_start > 0 && b_start > 0 && a[a_start - 1] == b[b_start - 1] {
                a_start -= 1;
                b_start -= 1;
            }
            let mut a_end = i + ANCHOR_LENGTH;
            let mut b_end = j + ANCHOR_LENGTH;
            while a_end < a.len() && b_end < b.len() && a[a_end] == b[b_end] {
                a_end += 1;
                b_end += 1;
            }
            let length = a_end - a_start;
            if best.as_ref().is_none_or(|best| length > best.length) {
                best = Some(Anchor { a_start, b_start, length });
            }
            furthest_end = furthest_end.max(b_end);
        }
        // Positions inside a run already matched can only yield shorter runs, so skip past it.
        j = furthest_end;
    }
    best
}

/// Takes two `&[char]`; returns the number of characters at the start that they have in
/// common.
fn common_prefix_length(a: &[char], b: &[char]) -> usize {
    let max_len = a.len().min(b.len());
    let mut len = 0;
    while len < max_len && a[len] == b[len] {
        len += 1;
    }
    len
}

/// Takes two `&[char]`; returns the number of characters at the end that they have in common.
fn common_suffix_length(a: &[char], b: &[char]) -> usize {
    let max_len = a.len().min(b.len());
    let mut len = 0;
    while len < max_len && a[a.len() - 1 - len] == b[b.len() - 1 - len] {
        len += 1;
    }
    len
}

// ========== Encoding chunks ==========

/// Append characters to a String, escaped: any ']', '|' or '\' is preceded by a '\'.
/// Writing straight into the output means escaping never allocates.
fn push_escaped(out: &mut String, chars: &[char]) {
    for &c in chars {
        match c {
            ']' | '|' | '\\' => {out.push('\\'); out.push(c)}
            ch => {out.push(ch)}
        }
    }
}

/// Take a series of chunks and convert it into an encoded string.
fn encode_diff(chunks: Vec<Chunk<'_>>) -> String {
    let mut diff_encoder = DiffEncoder::new();
    for chunk in chunks {
        diff_encoder.push_chunk(chunk);
    }
    diff_encoder.into()
}

/// An object that is used to convert from a list of Chunks to our custom "diff" string
/// format.
///
/// To use:
/// ```ignore
/// let mut diff_encoder = DiffEncoder::new();
/// for chunk in chunks {
///     diff_encoder.push_chunk(chunk);
/// }
/// let result: String = diff_encoder.into();
/// ```
struct DiffEncoder<'a> {
    string: String,
    queued: QueuedChunk<'a>,
    prev_was_equal: bool,
}

impl<'a> DiffEncoder<'a> {
    /// Construct a new DiffEncoder
    fn new() -> Self {
        DiffEncoder {
            string: Default::default(),
            queued: QueuedChunk::None,
            prev_was_equal: false,
        }
    }

    /// Call this to add a Chunk into the DiffEncoder.
    fn push_chunk(&mut self, chunk: Chunk<'a>) {
        let queued: QueuedChunk = self.queued;
        match (queued, chunk) {
            (QueuedChunk::None,      Chunk::Equal(e))  => {self.push_equal(e)}
            (QueuedChunk::None,      Chunk::Insert(i)) => {self.push_queue(QueuedChunk::Insert(i))}
            (QueuedChunk::None,      Chunk::Delete(d)) => {self.push_queue(QueuedChunk::Delete(d))}
            (QueuedChunk::Insert(i), Chunk::Delete(d)) => {self.push_edit(d, i)}
            (QueuedChunk::Delete(d), Chunk::Insert(i)) => {self.push_edit(d, i)}
            (QueuedChunk::Insert(i), Chunk::Equal(e))  => {self.push_edit(&[], i); self.push_equal(e)}
            (QueuedChunk::Delete(d), Chunk::Equal(e))  => {self.push_edit(d, &[]); self.push_equal(e)}
            (QueuedChunk::Insert(_), Chunk::Insert(_)) => {unreachable!()}
            (QueuedChunk::Delete(_), Chunk::Delete(_)) => {unreachable!()}
        }
    }

    /// Add an Insert or Delete to the queue
    fn push_queue(&mut self, new_queued: QueuedChunk<'a>) {
        if !matches!(self.queued, QueuedChunk::None) {
            panic!("Queuing a new chunk when one is queued should never happen");
        }
        self.queued = new_queued;
        self.prev_was_equal = false;
    }

    /// Call this to push an "equal" (a length of undisturbed characters). Also clears the queue.
    fn push_equal(&mut self, s: &[char]) {
        if self.prev_was_equal {
            panic!("Two equal sections in a row should never happen");
        }
        let char_count = s.len(); // length in CHARACTERS (not bytes, grapheme clusters, or UTF-16 chars)
        self.string.push_str(char_count.to_string().as_str());
        self.queued = QueuedChunk::None;
        self.prev_was_equal = true;
    }

    /// Call this to push an "edit" (a delete / insert pair). Also clears the queue.
    fn push_edit(&mut self, del: &[char], ins: &[char]) {
        self.string.push('[');
        push_escaped(&mut self.string, del);
        self.string.push('|');
        push_escaped(&mut self.string, ins);
        self.string.push(']');
        self.queued = QueuedChunk::None;
        self.prev_was_equal = false;
    }

    /// Call this to apply whatever has been queued but not yet applied to the string
    fn complete_queued(&mut self) {
        match self.queued {
            QueuedChunk::None => {}
            QueuedChunk::Insert(s) => self.push_edit(&[], s),
            QueuedChunk::Delete(s) => self.push_edit(s, &[]),
        }
        self.prev_was_equal = false;
    }
}

/// Allow DiffEncoder.into() to convert to a String.
impl<'a> From<DiffEncoder<'a>> for String {
    fn from(mut val: DiffEncoder<'a>) -> Self {
        val.complete_queued();
        val.string
    }
}

/// For keeping track of what has been queued up but not yet written to the
/// string within a DiffEncoder.
#[derive(Clone, Copy)]
enum QueuedChunk<'a> {
    None,
    Insert(&'a [char]),
    Delete(&'a [char])
}

// ========== Public interface ==========

/// Called on two strings, returns None if they are identical, or a String representing
/// the diff if they are not.
pub fn diff(s1: &str, s2: &str) -> Option<String> {
    if s1.eq(s2) {
        None
    } else {
        // chars() iterates by Unicode code point (Rust's `char` is a Unicode scalar value),
        // which is the same unit JavaScript's Array.from() produces, so the character counts
        // written into the encoded diff mean the same thing in both implementations. These
        // two arrays are the only copy of the text made: the chunks borrow from them.
        let a: Vec<char> = s1.chars().collect();
        let b: Vec<char> = s2.chars().collect();
        Some(encode_diff(find_chunks(&a, &b)))
    }
}

/// Combine a title_diff and a body_diff into a single string representing differences in a
/// note. Each argument is a diff string in the format documented in docs/design_notes.md
/// under "Diff Format" (as produced by diff()), or None where that field is unchanged. The
/// result is one of "t:{title-diff}", "b:{body-diff}", or "t:{title-diff}|b:{body-diff}"
/// ("{" and "}" enclose descriptive text; other characters are literal), or None if both
/// arguments were None. This is the form stored in a note's undo_stack.
pub fn format_note_diff(title_diff: Option<String>, body_diff: Option<String>) -> Option<String> {
    match (title_diff, body_diff) {
        (None, None) => None,
        (None, Some(bd)) => Some(format!("b:{bd}")),
        (Some(td), None) => Some(format!("t:{td}")),
        (Some(td), Some(bd)) => Some(format!("t:{td}|b:{bd}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: asserts that diff(s1, s2) returns the expected encoded string.
    fn assert_diff(s1: &str, s2: &str, expected: &str) {
        assert_eq!(diff(s1, s2), Some(expected.to_string()), "diff({s1:?}, {s2:?})");
    }

    /// Helper: asserts that encode_diff on hand-crafted chunks returns the expected string.
    fn assert_encode(chunks: Vec<Chunk>, expected: &str) {
        assert_eq!(encode_diff(chunks.clone()), expected, "encode_diff({chunks:?})");
    }

    /// Helper: the characters of a string, for building chunks (which borrow their text).
    fn chars(s: &str) -> Vec<char> {
        s.chars().collect()
    }

    /// Helper: applies push_escaped to a whole string.
    fn escaped(s: &str) -> String {
        let mut out = String::new();
        push_escaped(&mut out, &chars(s));
        out
    }

    // --- identical strings ---

    #[test]
    fn test_identical_strings() {
        assert_eq!(diff("hello", "hello"), None);
    }

    #[test]
    fn test_identical_empty_strings() {
        assert_eq!(diff("", ""), None);
    }

    // --- pure deletion ---

    #[test]
    fn test_delete_middle() {
        assert_diff("dog cat bat kit pop", "dog kit pop", "4[cat bat |]7");
    }

    #[test]
    fn test_delete_at_start() {
        assert_diff("abc def", "def", "[abc |]3");
    }

    #[test]
    fn test_delete_at_end() {
        assert_diff("abc def", "abc", "3[ def|]");
    }

    #[test]
    fn test_delete_everything() {
        assert_diff("hello", "", "[hello|]");
    }

    // --- pure insertion ---

    #[test]
    fn test_insert_middle() {
        assert_diff("dog pop", "dog cat pop", "4[|cat ]3");
    }

    #[test]
    fn test_insert_at_start() {
        assert_diff("def", "abc def", "[|abc ]3");
    }

    #[test]
    fn test_insert_at_end() {
        assert_diff("abc", "abc def", "3[| def]");
    }

    #[test]
    fn test_insert_into_empty() {
        assert_diff("", "hello", "[|hello]");
    }

    // --- replacement ---

    #[test]
    fn test_replace_middle() {
        assert_diff("the cat sat", "the dog sat", "4[cat|dog]4");
    }

    #[test]
    fn test_replace_at_start() {
        assert_diff("hello world", "goodbye world", "[hello|goodbye]6");
    }

    #[test]
    fn test_replace_at_end() {
        assert_diff("hello world", "hello earth", "6[world|earth]");
    }

    #[test]
    fn test_complete_replacement() {
        assert_diff("abc", "xyz", "[abc|xyz]");
    }

    // --- multiple edits ---

    #[test]
    fn test_multiple_edits() {
        assert_diff("the cat ate the rat", "the dog ate the bat", "4[cat|dog]9[r|b]2");
    }

    /// Two edits far enough apart that the text between them is found as an anchor.
    #[test]
    fn test_scattered_edits_share_an_anchor() {
        let old = "The first paragraph mentions a cat. The second paragraph mentions a rat.";
        let new = "The first paragraph mentions a dog. The second paragraph mentions a bat.";
        assert_diff(old, new, "31[cat|dog]34[r|b]3");
    }

    /// Two blocks with nothing in common become a single delete/insert pair rather than
    /// being aligned on coincidental short runs.
    #[test]
    fn test_unrelated_text_is_not_aligned() {
        assert_diff(
            "Alpha bravo charlie delta",
            "Zulu yankee xray whiskey",
            "[Alpha bravo charlie delta|Zulu yankee xray whiskey]",
        );
    }

    /// A common run shorter than ANCHOR_LENGTH is not used as an anchor.
    #[test]
    fn test_short_common_run_is_not_an_anchor() {
        assert_diff("ok", "no", "[ok|no]");
    }

    // --- escaping ---

    #[test]
    fn test_escape_no_special_chars() {
        assert_eq!(escaped("hello"), "hello");
    }

    #[test]
    fn test_escape_bracket() {
        assert_eq!(escaped("a]b"), "a\\]b");
    }

    #[test]
    fn test_escape_pipe() {
        assert_eq!(escaped("a|b"), "a\\|b");
    }

    #[test]
    fn test_escape_backslash() {
        assert_eq!(escaped("a\\b"), "a\\\\b");
    }

    #[test]
    fn test_escape_all_special_chars() {
        assert_eq!(escaped("]|\\"), "\\]\\|\\\\");
    }

    #[test]
    fn test_escape_appends_rather_than_replacing() {
        let mut out = String::from("pre:");
        push_escaped(&mut out, &chars("a|b"));
        assert_eq!(out, "pre:a\\|b");
    }

    #[test]
    fn test_diff_with_special_chars_in_content() {
        assert_diff("a]b", "a|b", "1[\\]|\\|]1");
    }

    // --- unicode ---

    #[test]
    fn test_unicode_char_counting() {
        // "café" has 4 characters but 5 bytes; the counts in the diff are in characters
        assert_diff("café ok", "café no", "5[ok|no]");
    }

    #[test]
    fn test_emoji() {
        assert_diff("I like 🐱 pets", "I like 🐶 pets", "7[🐱|🐶]5");
    }

    /// A chunk boundary may fall inside a grapheme cluster but never inside a code point.
    #[test]
    fn test_grapheme_cluster_may_be_split() {
        assert_diff("cafe\u{301} shop", "cafe shop", "4[\u{301}|]5");
    }

    // --- encode_diff with hand-crafted chunks ---

    #[test]
    fn test_encode_equal_only() {
        let hello = chars("hello");
        assert_encode(vec![Chunk::Equal(&hello)], "5");
    }

    #[test]
    fn test_encode_delete_only() {
        let gone = chars("gone");
        assert_encode(vec![Chunk::Delete(&gone)], "[gone|]");
    }

    #[test]
    fn test_encode_insert_only() {
        let new = chars("new");
        assert_encode(vec![Chunk::Insert(&new)], "[|new]");
    }

    #[test]
    fn test_encode_delete_then_insert() {
        let (old, new) = (chars("old"), chars("new"));
        assert_encode(vec![Chunk::Delete(&old), Chunk::Insert(&new)], "[old|new]");
    }

    #[test]
    fn test_encode_insert_then_delete() {
        let (old, new) = (chars("old"), chars("new"));
        assert_encode(vec![Chunk::Insert(&new), Chunk::Delete(&old)], "[old|new]");
    }

    #[test]
    fn test_encode_edit_between_equals() {
        let (aa, bb, cc, dd) = (chars("aa"), chars("bb"), chars("cc"), chars("dd"));
        assert_encode(
            vec![Chunk::Equal(&aa), Chunk::Delete(&bb), Chunk::Insert(&cc), Chunk::Equal(&dd)],
            "2[bb|cc]2",
        );
    }

    // --- empty string edge cases ---

    #[test]
    fn test_encode_empty_equal() {
        // An equal chunk with empty string should produce "0"
        let x = chars("x");
        assert_encode(vec![Chunk::Delete(&x), Chunk::Equal(&[])], "[x|]0");
    }

    // --- shared vectors ---

    /// One case from tests/diff_vectors.json.
    #[derive(serde::Deserialize)]
    struct DiffVector {
        name: String,
        old_title: String,
        new_title: String,
        old_body: String,
        new_body: String,
        note_diff: Option<String>,
    }

    #[derive(serde::Deserialize)]
    struct DiffVectorFile {
        vectors: Vec<DiffVector>,
    }

    /// The vectors in tests/diff_vectors.json are shared with the JavaScript implementation
    /// in html/diff.js, which asserts the same values. The two are ports of one another, so
    /// a failure here means either that this implementation changed or that the two have
    /// drifted apart.
    #[test]
    fn test_shared_vectors() {
        let file: DiffVectorFile =
            serde_json::from_str(include_str!("../../../tests/diff_vectors.json"))
                .expect("tests/diff_vectors.json did not parse");
        assert!(!file.vectors.is_empty(), "diff_vectors.json contained no vectors");
        for vector in file.vectors {
            let actual = format_note_diff(
                diff(&vector.new_title, &vector.old_title),
                diff(&vector.new_body, &vector.old_body),
            );
            assert_eq!(actual, vector.note_diff, "vector {:?}", vector.name);
        }
    }

    // --- ChunkList ---

    #[test]
    fn test_chunk_list_drops_empty_chunks() {
        let x = chars("x");
        let mut chunk_list = ChunkList::new();
        chunk_list.push(Chunk::Equal(&[]));
        chunk_list.push(Chunk::Delete(&x));
        chunk_list.push(Chunk::Insert(&[]));
        assert_eq!(chunk_list.chunks, vec![Chunk::Delete(&x)]);
    }
}
