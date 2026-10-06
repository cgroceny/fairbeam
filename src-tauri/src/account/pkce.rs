// PKCE (RFC 7636, S256) and the OAuth `state` value.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

use super::provider::AuthError;

pub struct Pkce {
    /// 43 characters of base64url: sent with the token exchange only
    pub verifier: String,
    /// base64url(SHA-256(verifier)): sent with the authorization request
    pub challenge: String,
}

impl Pkce {
    pub fn new() -> Result<Pkce, AuthError> {
        Ok(Pkce::from_bytes(&random::<32>()?))
    }

    pub fn from_bytes(bytes: &[u8; 32]) -> Pkce {
        let verifier = b64url(bytes);
        let challenge = challenge_for(&verifier);
        Pkce { verifier, challenge }
    }
}

pub fn challenge_for(verifier: &str) -> String {
    b64url(&Sha256::digest(verifier.as_bytes()))
}

/// 128 random bits for `state`.
pub fn new_state() -> Result<String, AuthError> {
    Ok(b64url(&random::<16>()?))
}

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

fn random<const N: usize>() -> Result<[u8; N], AuthError> {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).map_err(|e| AuthError::Invalid(format!("no system randomness: {e}")))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rfc7636_appendix_b() {
        let bytes: [u8; 32] = [
            116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212,
            37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
        ];
        let p = Pkce::from_bytes(&bytes);
        assert_eq!(p.verifier, "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk");
        assert_eq!(p.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn verifiers_are_fresh_and_well_formed() {
        let a = Pkce::new().unwrap();
        let b = Pkce::new().unwrap();
        assert_ne!(a.verifier, b.verifier);
        // RFC 7636 4.1: 43..128 characters of [A-Z a-z 0-9 - . _ ~]
        assert_eq!(a.verifier.len(), 43);
        assert!(a.verifier.chars().all(|c| c.is_ascii_alphanumeric() || "-._~".contains(c)));
        assert_eq!(a.challenge, challenge_for(&a.verifier));
        assert_eq!(a.challenge.len(), 43);
        let s = new_state().unwrap();
        assert_eq!(s.len(), 22);
        assert_ne!(s, new_state().unwrap());
    }
}
