//! Reads the typed text out of Samsung Notes ".sdocx" files.
//!
//! A `.sdocx` is a ZIP archive holding Samsung's S-Pen SDK binary serialization (it is NOT
//! XML/OOXML, despite what some generic "file info" sites claim). One `.sdocx` is a single
//! Samsung Notes document, which may contain several pages. Each page can carry typed text
//! and/or S-Pen handwriting; a document may also be a PDF annotation. We extract only the
//! typed text; handwriting strokes, PDF content, and embedded media are ignored.
//!
//! The format is undocumented, so the layout below was reverse-engineered from sample files
//! and is necessarily a best guess. We deliberately do NOT fall back to heuristic string
//! scraping: if a file doesn't match the structure we expect, we recover no text from it (the
//! document imports zero notes) rather than guessing at what's text and what's binary noise.

use std::io::{Cursor, Read};

use time::UtcDateTime;
use time::format_description::well_known::Rfc3339;

/// The typed text and metadata recovered from one Samsung Notes document. This is deliberately
/// independent of the import machinery so that this module could become a standalone library.
pub struct SamsungTextNote {
    pub body: String,
    pub create_time: Option<String>, // RFC 3339, if recoverable
    pub modify_time: Option<String>, // RFC 3339, if recoverable
}

// --- Reverse-engineered layout constants (implementation detail; do not rely on these). ---

// Inside `note.note`, a run of typed text is encoded as:
//     u32 == TEXT_RECORD_TAG  (little-endian)
//     u32 == count of UTF-16 code units (little-endian)
//     count * u16             (UTF-16LE characters)
const TEXT_RECORD_TAG: u32 = 0x0000_00F9;

// Maximum number of notes we will even consider importing. Serves as a sanity cap
// so a corrupt/coincidental length can't make us allocate wildly.
const MAX_TEXT_UNITS: usize = 1 << 20;

// Document create/modify timestamps live near the start of `note.note` as u64 little-endian
// microseconds since the Unix epoch.
const OFFSET_CREATE: usize = 0x18;
const OFFSET_MODIFY: usize = 0x20;

// Plausible range for an epoch-microsecond timestamp: 1970-01-01 .. 2100-01-01. Used to reject
// values read from the wrong offset (in which case we simply omit the timestamp).
const MIN_PLAUSIBLE_MICROS: u64 = 0;
const MAX_PLAUSIBLE_MICROS: u64 = 4_102_444_800_000_000;

/// Parse a Samsung Notes `.sdocx` (a ZIP) and return its text notes. Handwriting strokes, PDF
/// content, and media are ignored. A document with no recoverable typed text yields an empty Vec.
///
/// Returns the typed text of the document (its pages joined together) as a single note. Returns
/// an `Err` only when the bytes are not a readable `.sdocx` (e.g. not a valid zip, or missing the
/// `note.note` entry).
pub fn extract_text_notes(sdocx_bytes: &[u8]) -> Result<Vec<SamsungTextNote>, String> {
    let note = read_zip_entry(sdocx_bytes, "note.note")?;

    // Pull the typed text out of the structured, tag-delimited records. If the file doesn't match
    // the structure we expect this finds nothing, and we import zero notes rather than guessing.
    let texts = scan_tagged_text(&note);

    let body = texts.join("\n").trim().to_string();
    if body.is_empty() {
        // No typed text: a pure-handwriting or pure-PDF document, or a format we don't recognize.
        return Ok(Vec::new());
    }

    Ok(vec![SamsungTextNote {
        body,
        create_time: read_timestamp(&note, OFFSET_CREATE),
        modify_time: read_timestamp(&note, OFFSET_MODIFY),
    }])
}

/// Read a single entry out of a zip archive held entirely in memory.
fn read_zip_entry(zip_bytes: &[u8], name: &str) -> Result<Vec<u8>, String> {
    let mut archive = zip::ZipArchive::new(Cursor::new(zip_bytes))
        .map_err(|err| format!("invalid sdocx (zip) file: {err}"))?;
    let mut file = archive.by_name(name)
        .map_err(|err| format!("sdocx missing '{name}': {err}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|err| format!("error reading '{name}' from sdocx: {err}"))?;
    Ok(buf)
}

/// Walk `buf` for `TEXT_RECORD_TAG`-delimited UTF-16LE text records and return the decoded strings,
/// in the order they appear.
fn scan_tagged_text(buf: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 8 <= buf.len() {
        if read_u32(buf, i) == TEXT_RECORD_TAG {
            let count = read_u32(buf, i + 4) as usize;
            let start = i + 8;
            if (1..=MAX_TEXT_UNITS).contains(&count) {
                if let Some(end) = start.checked_add(count * 2) {
                    if end <= buf.len() {
                        if let Some(text) = decode_utf16le(&buf[start..end]) {
                            if is_plausible_text(&text) {
                                out.push(text);
                                i = end;
                                continue;
                            }
                        }
                    }
                }
            }
        }
        i += 1;
    }
    out
}

/// Read a u64 little-endian microsecond timestamp at `offset` and format it as RFC 3339, or `None`
/// if it's missing or implausible.
fn read_timestamp(buf: &[u8], offset: usize) -> Option<String> {
    let end = offset.checked_add(8)?;
    if end > buf.len() {
        return None;
    }
    let micros = u64::from_le_bytes(buf[offset..end].try_into().ok()?);
    if !(MIN_PLAUSIBLE_MICROS..=MAX_PLAUSIBLE_MICROS).contains(&micros) {
        return None;
    }
    let nanos = (micros as i128).checked_mul(1_000)?;
    UtcDateTime::from_unix_timestamp_nanos(nanos)
        .ok()?
        .format(&Rfc3339)
        .ok()
}

/// Decode bytes as UTF-16LE, returning `None` if the byte count is odd or the units aren't valid
/// UTF-16. The strict (non-lossy) decode doubles as a validity check while scanning.
fn decode_utf16le(bytes: &[u8]) -> Option<String> {
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16(&units).ok()
}

/// A candidate string is plausible note text if it has at least one graphic (non-control)
/// character. This rejects a coincidental tag match whose payload is only nulls or control bytes.
fn is_plausible_text(s: &str) -> bool {
    s.chars().any(|c| !c.is_control())
}

/// Read a little-endian u32 at `offset`. The caller must guarantee `offset + 4 <= buf.len()`.
fn read_u32(buf: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(buf[offset..offset + 4].try_into().expect("4-byte slice"))
}


#[cfg(test)]
mod tests {
    use super::*;

    // The reverse-engineering sample. include_bytes! reads it at compile time.
    const SAMPLE: &[u8] = include_bytes!("../../../sample_docs/Notes_260512_174108.sdocx");
    const SAMPLE_TEXT: &str = "Practice Danny Boy(C) and you'll never walk alone";

    #[test]
    fn extracts_sample_text() {
        let notes = extract_text_notes(SAMPLE).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].body, SAMPLE_TEXT);
    }

    #[test]
    fn extracts_sample_timestamps() {
        let notes = extract_text_notes(SAMPLE).unwrap();
        let create = notes[0].create_time.as_deref().expect("create_time");
        let modify = notes[0].modify_time.as_deref().expect("modify_time");
        assert!(create.starts_with("2026-05-12"), "create_time was {create}");
        assert!(modify.starts_with("2026-05-12"), "modify_time was {modify}");
    }

    #[test]
    fn tagged_scan_picks_only_the_real_text() {
        let note = read_zip_entry(SAMPLE, "note.note").unwrap();
        assert_eq!(scan_tagged_text(&note), vec![SAMPLE_TEXT.to_string()]);
    }

    #[test]
    fn is_plausible_text_requires_a_graphic_character() {
        assert!(is_plausible_text("Practice Danny Boy"));
        // A UUID-shaped string is real note content, not metadata to filter out.
        assert!(is_plausible_text("d5759550-4e42-11f1-b104-9f0876ea5f60"));
        // A payload of only control characters (e.g. a coincidental tag match) is rejected.
        assert!(!is_plausible_text("\0\0\0"));
    }

    #[test]
    fn non_zip_input_errors() {
        assert!(extract_text_notes(b"this is not a zip file").is_err());
    }
}
