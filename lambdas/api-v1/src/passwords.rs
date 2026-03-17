//! This file contains code for hashing passwords.

use std::fmt::Formatter;


// PASSWORDS will be hashed using Argon2id, following the advice from [1]. Given the level
// of operational security on the site, I will choose (for now) not to use a pepper. I will
// use the argon2 crate [2] from the RustCrypto project, as that project is well-respected and
// the crate is 100% rust.
//
// [1] https://web.archive.org/web/20231027095329/https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
// [2] https://crates.io/crates/argon2

use argon2::{
    password_hash,
    password_hash::{
        rand_core::OsRng,
        PasswordHash, PasswordHasher, PasswordVerifier, SaltString
    },
    Argon2
};

/// An error type returned when something went wrong while trying to hash
/// a password. If returned when attempting to generate a hash, there is
/// not really any way to recover from this. If returned when attempting to
/// verify a hash, it could be a sign that the password_hash string is
/// wrong or contains something not supported.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct HashFailedError(password_hash::errors::Error);

impl From<password_hash::errors::Error> for HashFailedError {
    fn from(value: password_hash::errors::Error) -> Self {
        HashFailedError(value)
    }
}

impl std::fmt::Display for HashFailedError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "hash failed: {}", self.0)
    }
}

impl std::error::Error for HashFailedError {
}


/// This is given a new password. It generates a salt, then hashes the
/// password, and returns a string which encodes details of the hash
/// settings, the salt, and the hashed password. That string can later
/// be used to verify a password.
pub fn generate_password_hash(password: &str) -> Result<String, HashFailedError> {
    let salt = SaltString::generate(&mut OsRng);
    let hasher = Argon2::default(); // accept default settings picked by RustCrypto
    let password_hash = hasher.hash_password(password.as_bytes(), &salt)?;
    Ok(password_hash.to_string())
}

/// This is given a password and the output of initial_hash_password (which is
/// a string containing the hash along with other info like the salt and the
/// particular algorithm and settings used. It returns true if the password
/// matches the one used to generate the hash in the first place and false if not.
pub fn verify_password(password: &str, password_hash: &str) -> Result<bool, HashFailedError> {
    let hash_object = PasswordHash::new(password_hash)?;
    let hasher = Argon2::default(); // accept default settings picked by RustCrypto
    Ok(hasher.verify_password(password.as_bytes(), &hash_object).is_ok())
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn test_hash_password() -> Result<(),HashFailedError> {
        let password_hash = generate_password_hash("abc123")?;
        println!("Password hash = '{}'", password_hash);
        let bad_verify = verify_password("xxx000", &password_hash)?;
        assert_eq!(bad_verify, false);
        let good_verify = verify_password("abc123", &password_hash)?;
        assert_eq!(good_verify, true);
        Ok(())
    }
}
