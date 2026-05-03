use rand::RngExt;

pub const NOTES_PER_BATCH: i32 = 100;
pub const SOFT_DELETE_DAYS: u64 = 30;
pub const SESSION_LIFETIME_DAYS: u64 = 30;

pub const ID_ALPHABET: &[u8; 64] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~";
pub const ID_LENGTH: usize = 10;

/// Function to validate an id of the default length; returns true if it is valid.
pub fn is_valid_id(id: &str) -> bool {
    is_valid_id_of_length(id, ID_LENGTH)
}

/// Function to validate an id of a given length; returns true if it is valid.
pub fn is_valid_id_of_length(id: &str, len: usize) -> bool {
    id.len() == len && id.chars().all(|x| x.is_ascii_alphanumeric() || x == '_' || x == '~')
}

/// Generate a random id of the default length using ID_ALPHABET.
pub fn generate_id() -> String {
    generate_id_of_length(ID_LENGTH)
}

/// Generate a random id of the given length using ID_ALPHABET.
pub fn generate_id_of_length(len: usize) -> String {
    let mut rng = rand::rng();
    (0..len)
        .map(|_| ID_ALPHABET[rng.random_range(0..64)] as char)
        .collect()
}

/// Generate a fresh random u32. Used for sources of randomness that don't
/// need a specific distribution (e.g. the burn die in the password-reset
/// change handler).
pub fn random_u32() -> u32 {
    rand::random()
}

/// Compare two strings for equality without short-circuiting on the first
/// differing byte. Lengths are compared early; for callers where the
/// inputs are always known length this is fine, otherwise the length leak
/// is something to consider.
pub fn constant_time_eq(a: &str, b: &str) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff: u8 = 0;
    for (x, y) in a.bytes().zip(b.bytes()) {
        diff |= x ^ y;
    }
    diff == 0
}

/// This implements the following algorithm for setting the title based on the body:
/// Find the first non-blank line, and take the first 40 characters of that line. If
/// there is no non-blank line, use the string "Note".
pub fn get_title_from_body(body: &str) -> String {
    body.lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.chars().take(40).collect())
        .unwrap_or_else(|| "Note".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_id() {
        let id = generate_id();
        assert!(is_valid_id(&id), "generated id '{id}' should be valid");
    }

    #[test]
    fn test_generate_id_uniqueness() {
        let id1 = generate_id();
        let id2 = generate_id();
        assert_ne!(id1, id2, "two generated ids should differ");
    }

    #[test]
    fn test_generate_id_of_length() {
        let id = generate_id_of_length(32);
        assert_eq!(id.len(), 32);
        assert!(is_valid_id_of_length(&id, 32));
        assert!(!is_valid_id_of_length(&id, 10));
    }

    #[test]
    fn test_constant_time_eq_matches() {
        assert!(constant_time_eq("abc", "abc"));
        assert!(constant_time_eq("", ""));
    }

    #[test]
    fn test_constant_time_eq_mismatches() {
        assert!(!constant_time_eq("abc", "abd"));
        assert!(!constant_time_eq("abc", "ab"));
        assert!(!constant_time_eq("ab", "abc"));
        assert!(!constant_time_eq("", "x"));
    }
}
