//! gnomon desktop: one window over `gnomon dashboard`.
//!
//! The window shows one of two things: the bundled launcher (pick a folder,
//! recent folders, is gnomon installed), or the dashboard page that the
//! installed gnomon serves on 127.0.0.1 for the chosen folder. There is no
//! second UI and no new authority: every screen past the launcher is the
//! dashboard's own, and the app adds nothing the CLI lacks.
//!
//! Security, in one place (README "Security model"):
//! - The sign-in link comes over the child's stdout pipe (gnomon-desktop-core
//!   `dashboard`), never a file or a socket.
//! - `on_navigation` lets the window show the launcher or
//!   `http://127.0.0.1:<this dashboard's port>` and nothing else; new windows
//!   and downloads are refused.
//! - The page on 127.0.0.1 is a remote origin to Tauri and has no capability:
//!   it cannot reach any command, plugin or core API. The launcher's
//!   capability names only this app's eight commands, and each command checks
//!   again that it was called from the launcher.
//! - The launcher never names a path: folders come from the native dialog,
//!   recent ones by their index in the app's own list.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use gnomon_desktop_core::cli::{self, CliProbe, ProbeError};
use gnomon_desktop_core::dashboard::{describe_exit, DashboardProcess, StartOptions};
use gnomon_desktop_core::nav;
use gnomon_desktop_core::project::{self, Project};
use gnomon_desktop_core::settings::{self, Settings};
use serde::Serialize;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, Manager, RunEvent, Runtime, Url, Webview, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";
const TITLE: &str = "gnomon";
const INSTALL_GUIDE: &str =
    "https://github.com/eljaplacido/gnomonharness/blob/master/GETTING_STARTED.md";
const INSTALL_SH: &str = "curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | sh";
const INSTALL_PS1: &str = "irm https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.ps1 | iex";
const INSTALL_NPM: &str = "npm i -g gnomon-harness";
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const START_TIMEOUT: Duration = Duration::from_secs(60);
/// Run once the dashboard has loaded, to show its Setup screen. A constant:
/// the app never builds script from data. It leaves a sign-in fragment alone.
const GO_TO_SETUP: &str = r##"if (!/^#k=/.test(location.hash)) { location.hash = "#/setup"; }"##;

type Res<T> = Result<T, String>;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ── State ────────────────────────────────────────────────────────────────────

struct Desktop {
    settings_path: PathBuf,
    inner: Mutex<Inner>,
    /// Held for a whole open or stop, so two never interleave.
    switching: Mutex<()>,
    /// The dashboard's port, 0 when none: what `on_navigation` lets through.
    port: Arc<AtomicU16>,
    /// Bumped on every start and stop: an exit notice from an older server
    /// is recognised as old and ignored.
    generation: AtomicU64,
    /// Show the dashboard's Setup screen once it has loaded.
    to_setup: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    settings: Settings,
    /// None until probed.
    cli: Option<Result<CliProbe, String>>,
    server: Option<DashboardProcess>,
    project: Option<Project>,
    /// Shown by the launcher once, then cleared.
    notice: Option<String>,
}

#[derive(Serialize)]
struct CliView {
    found: bool,
    path: Option<String>,
    version: Option<String>,
    dashboard: bool,
    setup: bool,
    problem: Option<String>,
}

#[derive(Serialize)]
struct RecentView {
    name: String,
    path: String,
    exists: bool,
    surface: bool,
}

#[derive(Serialize)]
struct InstallView {
    script: &'static str,
    script_shell: &'static str,
    npm: &'static str,
    guide: &'static str,
}

#[derive(Serialize)]
struct StatusView {
    cli: CliView,
    recent: Vec<RecentView>,
    first_run: bool,
    notice: Option<String>,
    install: InstallView,
}

#[derive(Serialize)]
struct SetupOutcome {
    opened: bool,
    message: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn search_dirs() -> Vec<PathBuf> {
    cli::candidate_dirs(&|k| std::env::var_os(k), home().as_deref())
}

impl Desktop {
    fn new(settings_path: PathBuf) -> Self {
        let settings = Settings::load(&settings_path);
        Desktop {
            settings_path,
            inner: Mutex::new(Inner {
                settings,
                ..Default::default()
            }),
            switching: Mutex::new(()),
            port: Arc::new(AtomicU16::new(0)),
            generation: AtomicU64::new(0),
            to_setup: Arc::new(AtomicBool::new(false)),
        }
    }

    fn save(&self, inner: &Inner) {
        if let Err(e) = inner.settings.save(&self.settings_path) {
            eprintln!(
                "gnomon-desktop: could not save {}: {e}",
                self.settings_path.display()
            );
        }
    }

    /// Find gnomon and ask it what it can do. `GNOMON_DESKTOP_CLI` (for
    /// development) wins, then a gnomon the user located, then the search.
    fn probe(&self) -> Result<CliProbe, String> {
        let chosen = lock(&self.inner).settings.gnomon.clone();
        let dirs = search_dirs();
        let program = std::env::var_os("GNOMON_DESKTOP_CLI")
            .map(PathBuf::from)
            .or(chosen.filter(|p| p.is_file()))
            .or_else(|| cli::find_in(&dirs, cli::executable_names()));
        let result = match program {
            None => Err(ProbeError::NotFound.to_string()),
            Some(p) => cli::probe(&p, &cli::child_path(&p, &dirs), PROBE_TIMEOUT)
                .map_err(|e| e.to_string()),
        };
        lock(&self.inner).cli = Some(result.clone());
        result
    }

    fn cli(&self) -> Result<CliProbe, String> {
        let known = lock(&self.inner).cli.clone();
        match known {
            Some(r) => r,
            None => self.probe(),
        }
    }

    fn status(&self, reprobe: bool) -> StatusView {
        let cli = if reprobe { self.probe() } else { self.cli() };
        let mut inner = lock(&self.inner);
        let cli = match cli {
            Ok(p) => CliView {
                found: true,
                path: Some(p.program.display().to_string()),
                version: Some(p.version.clone()),
                dashboard: p.has("dashboard"),
                setup: p.has("setup"),
                problem: None,
            },
            Err(why) => CliView {
                found: false,
                path: None,
                version: None,
                dashboard: false,
                setup: false,
                problem: Some(why),
            },
        };
        let recent = inner
            .settings
            .recent
            .iter()
            .map(|r| RecentView {
                name: project::display_name(&r.path),
                path: r.path.display().to_string(),
                exists: r.path.is_dir(),
                surface: r.path.join(".gnomon").exists(),
            })
            .collect::<Vec<_>>();
        StatusView {
            cli,
            first_run: recent.is_empty(),
            recent,
            notice: inner.notice.take(),
            install: InstallView {
                script: if cfg!(windows) {
                    INSTALL_PS1
                } else {
                    INSTALL_SH
                },
                script_shell: if cfg!(windows) {
                    "PowerShell"
                } else {
                    "a terminal"
                },
                npm: INSTALL_NPM,
                guide: INSTALL_GUIDE,
            },
        }
    }

    /// Use a gnomon the user located by hand, if it answers like gnomon.
    fn use_program(&self, program: PathBuf) -> Res<()> {
        if !cli::acceptable_program(&program) {
            return Err(
                "Choose gnomon.cmd or gnomon.exe (npm puts them in %APPDATA%\\npm).".into(),
            );
        }
        let probe = cli::probe(
            &program,
            &cli::child_path(&program, &search_dirs()),
            PROBE_TIMEOUT,
        )
        .map_err(|e| e.to_string())?;
        let mut inner = lock(&self.inner);
        inner.settings.gnomon = Some(program);
        inner.cli = Some(Ok(probe));
        self.save(&inner);
        Ok(())
    }

    /// Stop the dashboard, if one runs. The window is left where it is.
    fn stop_server(&self) {
        self.generation.fetch_add(1, SeqCst);
        self.port.store(0, SeqCst);
        let old = {
            let mut inner = lock(&self.inner);
            inner.project = None;
            inner.server.take()
        };
        // Dropping stops it, outside the state lock: that can take seconds.
        drop(old);
    }

    /// Start the dashboard for `picked` and show it.
    fn open<R: Runtime>(&self, app: &AppHandle<R>, picked: &Path, to_setup: bool) -> Res<()> {
        let _switching = lock(&self.switching);
        let project = project::open_folder(picked).map_err(|e| e.to_string())?;
        let cli = self.cli()?;
        if !cli.has("dashboard") {
            return Err(format!(
                "{} has no `gnomon dashboard`. Update gnomon to a release that has it (`gnomon update`), \
                 or choose another gnomon with Locate gnomon.",
                cli.version
            ));
        }
        self.stop_server();
        let generation = self.generation.fetch_add(1, SeqCst) + 1;
        let opts = StartOptions {
            program: cli.program.clone(),
            project: project.root.clone(),
            path_env: cli::child_path(&cli.program, &search_dirs()),
            timeout: START_TIMEOUT,
        };
        let handle = app.clone();
        let (server, link) =
            DashboardProcess::start(&opts, move || server_exited(&handle, generation))
                .map_err(|e| e.to_string())?;
        let url: Url = link
            .url()
            .parse()
            .map_err(|e| format!("bad sign-in link: {e}"))?;
        {
            let mut inner = lock(&self.inner);
            inner.server = Some(server);
            inner.project = Some(project.clone());
            inner.settings.touch(&project.root, now());
            self.save(&inner);
        }
        // The port first: on_navigation reads it when the navigation starts.
        self.port.store(link.port(), SeqCst);
        self.to_setup.store(to_setup, SeqCst);
        let window = main_window(app)?;
        let _ = window.set_title(&format!("{TITLE} · {}", project.name));
        window.navigate(url).map_err(|e| e.to_string())
    }

    fn open_recent<R: Runtime>(&self, app: &AppHandle<R>, index: usize) -> Res<()> {
        let path = lock(&self.inner)
            .settings
            .recent
            .get(index)
            .map(|r| r.path.clone());
        let path = path.ok_or("That project is no longer in the list.")?;
        self.open(app, &path, false)
    }

    /// Restart the dashboard for the open project: a fresh sign-in link.
    fn reconnect<R: Runtime>(&self, app: &AppHandle<R>) -> Res<()> {
        let root = lock(&self.inner).project.as_ref().map(|p| p.root.clone());
        match root {
            Some(root) => self.open(app, &root, false),
            None => {
                show_launcher(app);
                Ok(())
            }
        }
    }
}

fn main_window<R: Runtime>(app: &AppHandle<R>) -> Res<WebviewWindow<R>> {
    app.get_webview_window(MAIN)
        .ok_or_else(|| "the window is gone".to_string())
}

fn show_launcher<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.set_title(TITLE);
        if let Ok(u) = Url::parse(nav::launcher_url()) {
            let _ = w.navigate(u);
        }
    }
}

/// The child's stdout closed. If it was the current server, it stopped on
/// its own: go back to the launcher and say why.
fn server_exited<R: Runtime>(app: &AppHandle<R>, generation: u64) {
    let Some(d) = app.try_state::<Desktop>() else {
        return;
    };
    let _switching = lock(&d.switching);
    if d.generation.load(SeqCst) != generation {
        return; // stopped by this app, or replaced
    }
    let (server, name) = {
        let mut inner = lock(&d.inner);
        (inner.server.take(), inner.project.take().map(|p| p.name))
    };
    let Some(mut server) = server else { return };
    let why = match server.exit_within(Duration::from_secs(2)) {
        Some(code) => describe_exit(code),
        None => "gnomon dashboard closed its output".to_string(),
    };
    let tail = server.stderr_tail();
    drop(server);
    d.generation.fetch_add(1, SeqCst);
    d.port.store(0, SeqCst);
    let mut notice = format!(
        "The dashboard for {} stopped: {why}.",
        name.unwrap_or_else(|| "this project".into())
    );
    if !tail.trim().is_empty() {
        notice.push('\n');
        notice.push_str(tail.trim());
    }
    lock(&d.inner).notice = Some(notice);
    show_launcher(app);
}

fn pick_folder<R: Runtime>(app: &AppHandle<R>, title: &str) -> Res<Option<PathBuf>> {
    let mut dialog = app.dialog().file().set_title(title);
    if let Some(w) = app.get_webview_window(MAIN) {
        dialog = dialog.set_parent(&w);
    }
    match dialog.blocking_pick_folder() {
        None => Ok(None),
        Some(p) => p.into_path().map(Some).map_err(|e| e.to_string()),
    }
}

// ── Commands: the launcher's, and only the launcher's ───────────────────────

/// Every command refuses a caller that is not the bundled launcher, on top of
/// the capability that already grants them to nothing else.
fn from_launcher<R: Runtime>(webview: &Webview<R>) -> Res<()> {
    let url = webview.url().map_err(|e| e.to_string())?;
    if nav::is_launcher(url.scheme(), url.host_str()) {
        Ok(())
    } else {
        Err("only the launcher may ask this".into())
    }
}

/// Run blocking work (a spawn, a native dialog) off the main thread.
async fn off_main<R: Runtime, T: Send + 'static>(
    app: AppHandle<R>,
    f: impl FnOnce(&AppHandle<R>, &Desktop) -> Res<T> + Send + 'static,
) -> Res<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let d = app.try_state::<Desktop>().ok_or("not ready")?;
        f(&app, &d)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn status<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Res<StatusView> {
    from_launcher(&webview)?;
    off_main(app, |_, d| Ok(d.status(false))).await
}

#[tauri::command]
async fn recheck<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Res<StatusView> {
    from_launcher(&webview)?;
    off_main(app, |_, d| Ok(d.status(true))).await
}

#[tauri::command]
async fn locate_gnomon<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Res<StatusView> {
    from_launcher(&webview)?;
    off_main(app, |app, d| {
        let mut dialog = app
            .dialog()
            .file()
            .set_title("Locate the gnomon executable");
        if let Some(w) = app.get_webview_window(MAIN) {
            dialog = dialog.set_parent(&w);
        }
        if let Some(p) = dialog.blocking_pick_file() {
            d.use_program(p.into_path().map_err(|e| e.to_string())?)?;
        }
        Ok(d.status(false))
    })
    .await
}

#[tauri::command]
async fn pick_project<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Res<bool> {
    from_launcher(&webview)?;
    off_main(app, |app, d| {
        match pick_folder(app, "Open a project folder")? {
            None => Ok(false),
            Some(p) => d.open(app, &p, false).map(|()| true),
        }
    })
    .await
}

#[tauri::command]
async fn open_recent<R: Runtime>(app: AppHandle<R>, webview: Webview<R>, index: usize) -> Res<()> {
    from_launcher(&webview)?;
    off_main(app, move |app, d| d.open_recent(app, index)).await
}

#[tauri::command]
async fn forget_recent<R: Runtime>(
    app: AppHandle<R>,
    webview: Webview<R>,
    index: usize,
) -> Res<StatusView> {
    from_launcher(&webview)?;
    off_main(app, move |_, d| {
        {
            let mut inner = lock(&d.inner);
            inner.settings.forget(index);
            d.save(&inner);
        }
        Ok(d.status(false))
    })
    .await
}

#[tauri::command]
async fn setup_gnomon<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Res<SetupOutcome> {
    from_launcher(&webview)?;
    off_main(app, |app, d| {
        let cli = d.cli()?;
        if !cli.has("setup") {
            return Ok(SetupOutcome {
                opened: false,
                message: Some(format!(
                    "`gnomon setup` is not in this gnomon ({}) yet: it arrives with the setup wizard, and then \
                     this button opens the dashboard's Setup screen to run it. Until then, open a project folder \
                     and run `gnomon init` there in a terminal; the dashboard's Setup screen shows what the \
                     project declares.",
                    cli.version
                )),
            });
        }
        match pick_folder(app, "Choose the project folder to set up")? {
            None => Ok(SetupOutcome { opened: false, message: None }),
            Some(p) => d.open(app, &p, true).map(|()| SetupOutcome { opened: true, message: None }),
        }
    })
    .await
}

#[tauri::command]
async fn open_install_guide<R: Runtime>(app: AppHandle<R>, webview: Webview<R>) -> Res<()> {
    from_launcher(&webview)?;
    // A fixed URL: the page cannot choose what opens in the browser.
    app.opener()
        .open_url(INSTALL_GUIDE, None::<&str>)
        .map_err(|e| e.to_string())
}

// ── Window and menu ─────────────────────────────────────────────────────────

fn build_window<R: Runtime>(
    app: &AppHandle<R>,
    port: Arc<AtomicU16>,
    to_setup: Arc<AtomicBool>,
) -> tauri::Result<()> {
    let active = move |p: &AtomicU16| Some(p.load(SeqCst)).filter(|&p| p != 0);
    let nav_port = Arc::clone(&port);
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title(TITLE)
        .inner_size(1280.0, 860.0)
        .min_inner_size(760.0, 520.0)
        .center()
        .on_navigation(move |u| {
            nav::navigation_allowed(
                u.as_str(),
                u.scheme(),
                u.host_str(),
                u.port_or_known_default(),
                active(&nav_port),
            )
        })
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false)
        .on_page_load(move |window, payload| {
            if !matches!(payload.event(), PageLoadEvent::Finished) {
                return;
            }
            let u = payload.url();
            if nav::is_dashboard(
                u.scheme(),
                u.host_str(),
                u.port_or_known_default(),
                active(&port),
            ) && to_setup.swap(false, SeqCst)
            {
                let _ = window.eval(GO_TO_SETUP);
            }
        })
        .build()?;
    Ok(())
}

fn menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let open = MenuItemBuilder::with_id("open", "Open Project Folder…")
        .accelerator("CmdOrCtrl+O")
        .build(app)?;
    let reconnect = MenuItemBuilder::with_id("reconnect", "Reconnect to Dashboard")
        .accelerator("CmdOrCtrl+Shift+R")
        .build(app)?;
    let close = MenuItemBuilder::with_id("close", "Close Project").build(app)?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&open)
        .item(&reconnect)
        .item(&close);
    let file = if cfg!(target_os = "macos") {
        file.build()?
    } else {
        file.separator().quit().build()?
    };
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let builder = MenuBuilder::new(app);
    #[cfg(target_os = "macos")]
    let builder = {
        let app_menu = SubmenuBuilder::new(app, "gnomon-desktop")
            .about(None)
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        builder.item(&app_menu)
    };
    builder.item(&file).item(&edit).build()
}

fn on_menu<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let app = app.clone();
    match id {
        "open" | "reconnect" => {
            let reconnect = id == "reconnect";
            tauri::async_runtime::spawn_blocking(move || {
                let Some(d) = app.try_state::<Desktop>() else {
                    return;
                };
                let result = if reconnect {
                    d.reconnect(&app)
                } else {
                    match pick_folder(&app, "Open a project folder") {
                        Ok(Some(p)) => d.open(&app, &p, false),
                        Ok(None) => Ok(()),
                        Err(e) => Err(e),
                    }
                };
                if let Err(e) = result {
                    lock(&d.inner).notice = Some(e);
                    show_launcher(&app);
                }
            });
        }
        "close" => {
            tauri::async_runtime::spawn_blocking(move || {
                if let Some(d) = app.try_state::<Desktop>() {
                    let _switching = lock(&d.switching);
                    d.stop_server();
                }
                show_launcher(&app);
            });
        }
        _ => {}
    }
}

fn stop_everything<R: Runtime, M: Manager<R>>(m: &M) {
    if let Some(d) = m.try_state::<Desktop>() {
        d.stop_server();
    }
}

fn main() {
    tauri::Builder::default()
        // First, so a second launch only focuses this window.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .menu(menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if window.label() == MAIN
                && matches!(
                    event,
                    WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                )
            {
                stop_everything(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            status,
            recheck,
            locate_gnomon,
            pick_project,
            open_recent,
            forget_recent,
            setup_gnomon,
            open_install_guide
        ])
        .setup(|app| {
            let settings_path = app.path().app_config_dir()?.join(settings::FILE_NAME);
            let desktop = Desktop::new(settings_path);
            let (port, to_setup) = (Arc::clone(&desktop.port), Arc::clone(&desktop.to_setup));
            app.manage(desktop);
            build_window(app.handle(), port, to_setup)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("gnomon-desktop failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                stop_everything(app);
            }
        });
}
