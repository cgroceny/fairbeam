// Where tokens live: the OS credential store (macOS Keychain, Windows Credential Manager) through
// the `keyring` crate, behind a trait so tests use memory.

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::Mutex;

use super::provider::{AuthError, ProviderId, Tokens};

/// Keychain service name: the app's bundle identifier (tauri.conf.json).
pub const SERVICE: &str = "org.fairbeam.desktop";

pub trait SecretStore: Send + Sync {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError>;
    fn set(&self, key: &str, value: &str) -> Result<(), AuthError>;
    /// Deleting what is not there is fine.
    fn delete(&self, key: &str) -> Result<(), AuthError>;
}

pub fn tokens_key(provider: ProviderId) -> String {
    format!("oauth-{}", provider.as_str())
}

pub fn load_tokens(store: &impl SecretStore, provider: ProviderId) -> Result<Option<Tokens>, AuthError> {
    match store.get(&tokens_key(provider))? {
        // an unreadable entry is treated as absent (it is replaced at the next sign-in)
        Some(json) => Ok(serde_json::from_str(&json).ok()),
        None => Ok(None),
    }
}

pub fn save_tokens(store: &impl SecretStore, provider: ProviderId, tokens: &Tokens) -> Result<(), AuthError> {
    let json = serde_json::to_string(tokens).map_err(|e| AuthError::Store(e.to_string()))?;
    store.set(&tokens_key(provider), &json)
}

pub fn delete_tokens(store: &impl SecretStore, provider: ProviderId) -> Result<(), AuthError> {
    store.delete(&tokens_key(provider))
}

/// In memory, for tests.
#[cfg(test)]
#[derive(Default)]
pub struct MemoryStore {
    entries: Mutex<HashMap<String, String>>,
    pub calls: Mutex<usize>,
}

#[cfg(test)]
impl MemoryStore {
    fn touch(&self) {
        *self.calls.lock().unwrap() += 1;
    }
}

#[cfg(test)]
impl SecretStore for MemoryStore {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
        self.touch();
        Ok(self.entries.lock().unwrap().get(key).cloned())
    }
    fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
        self.touch();
        self.entries.lock().unwrap().insert(key.into(), value.into());
        Ok(())
    }
    fn delete(&self, key: &str) -> Result<(), AuthError> {
        self.touch();
        self.entries.lock().unwrap().remove(key);
        Ok(())
    }
}

/// The OS credential store. Errors never include the secret.
#[cfg(feature = "accounts")]
pub struct KeyringStore;

#[cfg(feature = "accounts")]
impl KeyringStore {
    fn entry(key: &str) -> Result<keyring::Entry, AuthError> {
        keyring::Entry::new(SERVICE, key).map_err(|e| AuthError::Store(e.to_string()))
    }
}

#[cfg(feature = "accounts")]
impl SecretStore for KeyringStore {
    fn get(&self, key: &str) -> Result<Option<String>, AuthError> {
        match Self::entry(key)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AuthError::Store(e.to_string())),
        }
    }
    fn set(&self, key: &str, value: &str) -> Result<(), AuthError> {
        Self::entry(key)?.set_password(value).map_err(|e| AuthError::Store(e.to_string()))
    }
    fn delete(&self, key: &str) -> Result<(), AuthError> {
        match Self::entry(key)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AuthError::Store(e.to_string())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_round_trip_per_provider_and_delete_is_idempotent() {
        let store = MemoryStore::default();
        let t = Tokens { access_token: "a".into(), refresh_token: Some("r".into()), expires_at: Some(5), scope: None };
        assert_eq!(load_tokens(&store, ProviderId::Github).unwrap(), None);
        save_tokens(&store, ProviderId::Github, &t).unwrap();
        assert_eq!(load_tokens(&store, ProviderId::Github).unwrap(), Some(t));
        assert_eq!(load_tokens(&store, ProviderId::Google).unwrap(), None);
        delete_tokens(&store, ProviderId::Github).unwrap();
        delete_tokens(&store, ProviderId::Github).unwrap();
        assert_eq!(load_tokens(&store, ProviderId::Github).unwrap(), None);
        store.set("oauth-google", "not json").unwrap();
        assert_eq!(load_tokens(&store, ProviderId::Google).unwrap(), None);
        assert_eq!(tokens_key(ProviderId::Google), "oauth-google");
    }
}
