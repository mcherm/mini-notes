//! This file contains code where I'm experimenting with using a diff tool.
use std::borrow::Cow;
use dissimilar::{Chunk, diff as diss_diff};


/// Called on two strings, returns None if they are identical, or a String representing
/// the diff if they are not.
pub fn diff(s1: &str, s2: &str) -> Option<String> {
    if s1.eq(s2) {
        None
    } else {
        Some(encode_diff(diss_diff(s1, s2)))
    }
}

/// Escape a string.
fn escape_str<'a>(s: &'a str) -> Cow<'a, str> {
    if !s.contains(&[']', '|', '\\']) {
        Cow::Borrowed(s)
    } else {
        let mut escaped = String::with_capacity(s.len() + 3); // We'll add 3 bytes extra to reduce reallocation
        for c in s.chars() {
            match c {
                ']' => {escaped.push('\\'); escaped.push(']')}
                '|' => {escaped.push('\\'); escaped.push('|')}
                '\\' => {escaped.push('\\'); escaped.push('\\')}
                ch => {escaped.push(ch)}
            }
        }
        Cow::Owned(escaped)
    }
}

/// Take a series of chunks and convert it into an encoded string.
fn encode_diff(chunks: Vec<Chunk>) -> String {
    let mut diff_encoder = DiffEncoder::new();
    for chunk in chunks {
        diff_encoder.push_chunk(chunk);
    }
    diff_encoder.into()
}

/// An object that is used to convert from dissimilar's list of Chunks to our
/// custom "diff" string format.
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

impl <'a> DiffEncoder<'a> {
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
        let queued: QueuedChunk = self.queued.clone();
        match (queued, chunk) {
            (QueuedChunk::None,      Chunk::Equal(e))  => {self.push_equal(e)}
            (QueuedChunk::None,      Chunk::Insert(i)) => {self.push_queue(QueuedChunk::Insert(i))}
            (QueuedChunk::None,      Chunk::Delete(d)) => {self.push_queue(QueuedChunk::Delete(d))}
            (QueuedChunk::Insert(i), Chunk::Delete(d)) => {self.push_edit(d, i)}
            (QueuedChunk::Delete(d), Chunk::Insert(i)) => {self.push_edit(d, i)}
            (QueuedChunk::Insert(i), Chunk::Equal(e))  => {self.push_edit("", i); self.push_equal(e)}
            (QueuedChunk::Delete(d), Chunk::Equal(e))  => {self.push_edit(d, ""); self.push_equal(e)}
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
    fn push_equal(&mut self, s: &'a str) {
        if self.prev_was_equal {
            panic!("Two equal sections in a row should never happen");
        }
        let char_count = s.chars().count(); // length in CHARACTERS (not bytes, grapheme clusters, or UTF-16 chars)
        self.string.push_str(char_count.to_string().as_str());
        self.queued = QueuedChunk::None;
        self.prev_was_equal = true;
    }

    /// Call this to push an "edit" (a delete / insert pair). Also clears the queue.
    fn push_edit(&mut self, del: &'a str, ins: &'a str) {
        self.string.push('[');
        self.string.push_str(escape_str(del).as_ref());
        self.string.push('|');
        self.string.push_str(escape_str(ins).as_ref());
        self.string.push(']');
        self.queued = QueuedChunk::None;
        self.prev_was_equal = false;
    }

    /// Call this to apply whatever has been queued but not yet applied to the string
    fn complete_queued(&mut self) {
        match self.queued {
            QueuedChunk::None => {}
            QueuedChunk::Insert(s) => self.push_edit("", s),
            QueuedChunk::Delete(s) => self.push_edit(s, ""),
        }
        self.prev_was_equal = false;
    }
}

impl <'a> Into<String> for DiffEncoder<'a> {
    fn into(mut self) -> String {
        self.complete_queued();
        self.string
    }
}

/// For keeping track of what has been queued up but not yet written to the
/// string within a DiffEncoder.
#[derive(Clone)]
enum QueuedChunk<'a> {
    None,
    Insert(&'a str),
    Delete(&'a str)
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

    // --- escaping ---

    #[test]
    fn test_escape_str_no_special_chars() {
        assert_eq!(escape_str("hello"), Cow::Borrowed("hello"));
    }

    #[test]
    fn test_escape_str_bracket() {
        assert_eq!(escape_str("a]b"), Cow::<str>::Owned("a\\]b".to_string()));
    }

    #[test]
    fn test_escape_str_pipe() {
        assert_eq!(escape_str("a|b"), Cow::<str>::Owned("a\\|b".to_string()));
    }

    #[test]
    fn test_escape_str_backslash() {
        assert_eq!(escape_str("a\\b"), Cow::<str>::Owned("a\\\\b".to_string()));
    }

    #[test]
    fn test_escape_str_all_special_chars() {
        assert_eq!(escape_str("]|\\"), Cow::<str>::Owned("\\]\\|\\\\".to_string()));
    }

    #[test]
    fn test_diff_with_special_chars_in_content() {
        assert_diff("a]b", "a|b", "1[\\]|\\|]1");
    }

    // --- unicode ---

    #[test]
    fn test_unicode_char_counting() {
        // "café" has 4 characters but 5 bytes; dissimilar may split the diff
        assert_diff("café ok", "café no", "5[|n]1[k|]");
    }

    #[test]
    fn test_emoji() {
        assert_diff("I like 🐱 pets", "I like 🐶 pets", "7[🐱|🐶]5");
    }

    // --- encode_diff with hand-crafted chunks ---

    #[test]
    fn test_encode_equal_only() {
        assert_encode(vec![Chunk::Equal("hello")], "5");
    }

    #[test]
    fn test_encode_delete_only() {
        assert_encode(vec![Chunk::Delete("gone")], "[gone|]");
    }

    #[test]
    fn test_encode_insert_only() {
        assert_encode(vec![Chunk::Insert("new")], "[|new]");
    }

    #[test]
    fn test_encode_delete_then_insert() {
        assert_encode(
            vec![Chunk::Delete("old"), Chunk::Insert("new")],
            "[old|new]",
        );
    }

    #[test]
    fn test_encode_insert_then_delete() {
        assert_encode(
            vec![Chunk::Insert("new"), Chunk::Delete("old")],
            "[old|new]",
        );
    }

    #[test]
    fn test_encode_edit_between_equals() {
        assert_encode(
            vec![Chunk::Equal("aa"), Chunk::Delete("bb"), Chunk::Insert("cc"), Chunk::Equal("dd")],
            "2[bb|cc]2",
        );
    }

    // --- empty string edge cases ---

    #[test]
    fn test_encode_empty_equal() {
        // An equal chunk with empty string should produce "0"
        assert_encode(vec![Chunk::Delete("x"), Chunk::Equal("")], "[x|]0");
    }
}
