//! Optional sign-in with GitHub or Google (docs/ACCOUNTS.md). Built but switched off: this module
//! is compiled only with the `accounts` Cargo feature (and for unit tests). Guest mode is the
//! default either way; there is no backend.
//!
//! - `provider`: the `AuthProvider` trait, tokens, profiles, and the `Http`/`Clock` layers
//! - `github`: Device Flow; `google`: PKCE with a loopback redirect (`pkce`, `loopback`)
//! - `store`: tokens in the OS credential store; `service`: the switch guard and the flows
//! - `plugin`: the Tauri `account` plugin (feature only)

#![cfg_attr(not(feature = "accounts"), allow(dead_code))]

pub mod github;
pub mod google;
pub mod loopback;
pub mod pkce;
pub mod provider;
pub mod service;
pub mod store;
// the command list build.rs reads; here only for the switch tests
#[cfg(test)]
pub mod switch;

#[cfg(feature = "accounts")]
mod plugin;
#[cfg(feature = "accounts")]
pub use plugin::plugin;

/// The build-time switch.
pub const ENABLED: bool = cfg!(feature = "accounts");
