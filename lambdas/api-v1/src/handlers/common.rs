//! This file contains code that is shared by multiple handlers.



pub const MAX_TITLE_LEN: usize = 1000;
pub const MAX_BODY_LEN: usize = 100000;

/// Verifies that a title and body are of a valid size. Returns an error response if
/// they are not.
/// 
/// Limits: title may be up to 1,000 bytes of UTF-8. Body may be up to 100,000 bytes
/// of UTF-8.
pub fn verify_size(title: &str, body: &str) -> Result<(), String> {
    if title.len() > MAX_TITLE_LEN {
        return Err(format!("Title too long, exceeds {MAX_TITLE_LEN} bytes in UFF-8"))
    }
    if body.len() > MAX_BODY_LEN {
        return Err(format!("Body too long, exceeds {MAX_BODY_LEN} bytes in UFF-8"))
    }
    Ok(())
}
