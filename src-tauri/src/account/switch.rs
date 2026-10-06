// The accounts switch (docs/ACCOUNTS.md "The switch"). Shared with build.rs through #[path], so it
// uses std only.

/// Commands of the inlined `account` plugin; build.rs declares them (and their `allow-*`
/// permissions) only when the `accounts` feature is on.
pub const COMMANDS: &[&str] = &[
    "status",
    "sign_in_start",
    "sign_in_wait",
    "sign_in_cancel",
    "open_verification",
    "refresh",
    "sign_out",
];

/// The commands a build exposes: none unless the switch is on.
pub fn exposed_commands(enabled: bool) -> &'static [&'static str] {
    if enabled {
        COMMANDS
    } else {
        &[]
    }
}
