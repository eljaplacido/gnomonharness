# gnomon desktop

A desktop window over `gnomon dashboard` (CONTRACTS.md §17). It is a thin
shell, not a second UI: past its one launcher screen, everything you see is
the dashboard page your installed gnomon serves on 127.0.0.1, the same page a
browser shows. It adds no action the CLI lacks.

Status: draft. Built and tested by `.github/workflows/desktop.yml`; not
released, signed or auto-updated.

## What it does

1. Finds the gnomon CLI already on this machine (PATH, then where npm, the
   gnomon installer, nvm, Volta, pnpm and Homebrew put global binaries), and
   asks it `gnomon --help` whether it has `dashboard` (and `setup`). If there
   is none, the launcher shows the installer one-liner for your OS and
   `npm i -g gnomon-harness`, with "Check again" and "Locate gnomon…".
2. You pick a project folder in the native dialog. The app resolves its root
   the way the CLI does (nearest folder at or above with `.gnomon`) and runs
   `gnomon dashboard --no-open --port 0 --dir <root>`: the OS picks a free
   port, no browser opens.
3. It reads the one-use sign-in link from the child's **stdout pipe** and
   loads it in the window. The page trades it for a bearer token, exactly as
   in a browser.
4. Closing the window stops the server and everything it started. A second
   launch focuses the running window (single instance).

Recent folders are kept in the app's own config directory
(`com.gnomonharness.desktop/desktop.json` under the OS config dir), never in a
project. **Set up gnomon** opens the dashboard's Setup screen for a folder once
the installed gnomon has `gnomon setup` (the setup wizard, #127); until then it
says so and points at `gnomon init`.

Menu: File ▸ Open Project Folder… (Ctrl/Cmd+O), Reconnect to Dashboard
(Ctrl/Cmd+Shift+R: restart the server for a fresh sign-in), Close Project
(back to the launcher).

## Why it runs the installed gnomon instead of bundling one

Bundling Node and gnomon as a Tauri sidecar was considered and not done:

- **One engine.** The dashboard reads records that the gnomon in your terminal
  writes. A bundled copy would be a second gnomon at a possibly different
  version, reading another version's records and running its own actions: a
  new authority, which the design rules out.
- **Size.** The window alone is a few MB (table below). A sidecar adds a Node
  runtime (~40 MB compressed, ~100 MB installed per OS), the four gnomon
  packages and the native Rust binaries, per platform, roughly ten times the
  download.
- **No practical single binary.** gnomon is ESM across four packages and
  shells out to its Rust binaries; Node's single-executable apps cannot carry
  that without a bundling step gnomon does not have.
- **Release cadence.** The app would need a rebuild for every gnomon release.

You need gnomon in a terminal to produce anything the dashboard shows, so the
app asks for the install it will find anyway. A sidecar stays possible if
gnomon ships a standalone binary.

## Security model

| Layer | What holds |
|---|---|
| Link | Read from the child's stdout pipe, which only this process holds. No file, no socket, no environment variable. The parser accepts only `http://127.0.0.1:<1-65535>/#k=<base64url>`; the link is never logged (`Debug` redacts it). |
| Navigation | `on_navigation` allows the bundled launcher and `http://127.0.0.1:<this dashboard's port>`, nothing else: not `localhost`, not another port, not https. New windows and downloads are refused. |
| IPC | The dashboard page is a remote origin to Tauri and has **no capability**: no command, plugin or core API is reachable from it. The launcher's capability (`src-tauri/capabilities/launcher.json`) grants only this app's eight commands, declared in an app ACL manifest (`build.rs`); no fs, shell, dialog, opener or core permission is granted to any page. Each command also checks that its caller is the launcher. |
| Paths | The launcher never sends a path. Folders come from the native dialog; recent ones are named by their index in the app's own list. The one URL the app opens in your browser (the install guide) is a constant. |
| CSP | The launcher: `default-src 'none'`, scripts and styles from the app only, IPC only. The dashboard keeps the CSP its server sends (no inline script or style, `connect-src 'self'`). |
| Server | Unchanged: 127.0.0.1 only, Host/Origin/Sec-Fetch-Site checks, one-use bootstrap, bearer token, no cookies, no CORS. |
| Lifetime | Unix: the server leads its own process group, stopped with SIGTERM then SIGKILL. Windows: it runs in a kill-on-close Job Object, so it ends with the app even on a crash. On macOS and Linux a hard kill of the app (SIGKILL) can leave the server running until it is stopped; it still only serves 127.0.0.1 behind its token. |

No telemetry. No update check. Devtools are off in release builds.

## Size

Measured by the `Sizes` step of `desktop.yml` (see the run summary):

| Platform | Installer | Size |
|---|---|---|
| Windows | NSIS `.exe` / MSI | see run |
| macOS (arm64) | `.dmg` | see run |
| Linux | `.deb` / `.AppImage` | see run |

The window uses the OS webview (WebView2 on Windows, WKWebView on macOS,
WebKitGTK on Linux), so no browser engine ships inside it.

## Build

The logic lives in `core/` (no webview needed) and is tested with plain cargo:

```bash
cd packages/gnomon-desktop
cargo test -p gnomon-desktop-core
# against a real gnomon:
GNOMON_DESKTOP_TEST_CLI=$(command -v gnomon) cargo test -p gnomon-desktop-core --test dashboard_child
```

The window (`src-tauri/`) needs the platform's webview headers (on Linux,
`libwebkit2gtk-4.1-dev` and friends, see the workflow) and the Tauri CLI:

```bash
cd packages/gnomon-desktop/src-tauri
npx @tauri-apps/cli@2.12.4 build          # installers under ../target/release/bundle/
GNOMON_DESKTOP_CLI=/path/to/gnomon npx @tauri-apps/cli@2.12.4 dev
```

This is its own Cargo workspace, outside the repository's root workspace and
its test count, and it has no `package.json`, so pnpm ignores it.

## Trying a CI build on Windows

1. Open the latest **Desktop app** run for the pull request (Actions tab, or
   the checks list on the PR) and download the `gnomon-desktop-Windows`
   artifact. Unzip it.
2. Run `gnomon-desktop_0.1.0_x64-setup.exe`. It installs for your user only (no
   admin). The build is unsigned, so SmartScreen says "Windows protected your
   PC": choose **More info ▸ Run anyway**. The `.msi` is the same app for a
   per-machine install.
3. You need a gnomon that has `gnomon dashboard`. Until a release carries it,
   use a checkout of this branch: `pnpm run setup` links its `gnomon` globally.
4. Start **gnomon-desktop** from the Start menu, pick a project folder.

macOS: open the `.dmg`, drag the app to Applications, then right-click ▸ Open
the first time (unsigned). Linux: install the `.deb`, or `chmod +x` the
`.AppImage` (artifact zips drop the executable bit).

## Not yet (follow-ups)

- **Auto-update** (Tauri's updater, with signed update manifests). Off on
  purpose until there is a release channel.
- **Code signing** and macOS notarisation; a universal (Intel + Apple Silicon)
  macOS build.
- **A CLI flag that ends the server when stdin closes**, so a hard-killed app
  cannot leave a server behind on macOS or Linux.
- **Setup**: once `gnomon setup` is in a release, "Set up gnomon" runs it
  through the dashboard's Setup screen with no change here.
