#[path = "src/account/switch.rs"]
mod account_switch;

fn main() {
    // An app manifest makes every command need a permission: the splash page gets its own
    // (capabilities/default.json), the viewer served from 127.0.0.1 only reveal_download and
    // save_download
    // (capabilities/viewer.json).
    let commands = &[
        "splash_state",
        "retry",
        "install_runtime",
        "use_managed",
        "set_prefer_gpu",
        "set_gpu_build",
        "choose_python",
        "reveal_download",
        "reveal_design",
        "save_download",
        "get_general_settings",
        "set_update_check_on_start",
        "check_updates_now",
        "set_language",
        "open_workspace",
        "pick_workspace_folder",
        "pick_blender_executable",
        "set_workspace_folder",
        "install_gpu_runtime",
        "set_gpu_runtime_enabled",
        "open_external_link",
        "remember_recent_design",
        // usage statistics (docs/TELEMETRY.md), no-ops without the telemetry feature
        "telemetry_status",
        "telemetry_set_consent",
        "telemetry_preview",
        "telemetry_reset_id",
        // the viewer preferences imported from the previous app, once
        "take_imported_viewer_prefs",
    ];
    let mut attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    // optional sign-in (docs/ACCOUNTS.md): the `account` plugin and its permissions exist only
    // with `--features accounts`; the plugin adds its capability at runtime
    println!("cargo:rerun-if-changed=src/account/switch.rs");
    let accounts = std::env::var_os("CARGO_FEATURE_ACCOUNTS").is_some();
    let account_commands = account_switch::exposed_commands(accounts);
    if !account_commands.is_empty() {
        attributes = attributes.plugin(
            "account",
            tauri_build::InlinedPlugin::new()
                .commands(account_commands)
                .default_permission(tauri_build::DefaultPermissionRule::AllowAllCommands),
        );
    }
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}
