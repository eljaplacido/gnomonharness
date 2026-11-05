// The app's own commands are declared here so that Tauri checks them against
// the ACL like plugin commands: each gets an `allow-<name>` permission, and
// only a capability that grants it can call it. capabilities/launcher.json
// grants them to the bundled launcher page and to nothing else; the dashboard,
// a remote origin (http://127.0.0.1:<port>), has no capability at all.
//
// Keep in step with `generate_handler!` in src/main.rs.
const COMMANDS: &[&str] = &[
    "status",
    "recheck",
    "locate_gnomon",
    "pick_project",
    "open_recent",
    "forget_recent",
    "setup_gnomon",
    "open_install_guide",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("tauri-build failed");
}
