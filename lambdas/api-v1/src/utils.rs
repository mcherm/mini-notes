use rand::RngExt;

pub const NOTES_PER_BATCH: i32 = 100;

pub const ID_ALPHABET: &[u8; 64] = b"0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_~";
pub const ID_LENGTH: usize = 10;

/// Function to validate a CustomId; returns true if it is valid.
pub fn is_valid_id(id: &str) -> bool {
    // 10 bytes long, all ascii [0-9A-Za-z_~].
    id.len() == ID_LENGTH && id.chars().all(|x| x.is_ascii_alphanumeric() || x == '_' || x == '~')
}

/// Generate a random id: a 10-character base-64 string using ID_ALPHABET.
pub fn generate_id() -> String {
    let mut rng = rand::rng();
    (0..ID_LENGTH)
        .map(|_| ID_ALPHABET[rng.random_range(0..64)] as char)
        .collect()
}
