//! What the app remembers: recent project folders, and a gnomon the user
//! located by hand. One JSON file in the app's own config directory
//! (`<config>/com.gnomonharness.desktop/desktop.json`), never in a project and
//! never in `.gnomon/`.
//!
//! These are machine-local conveniences, like a browser's history: they
//! change which folder opens with one click, not what gnomon does there. A
//! missing, unreadable or corrupt file reads as empty, and is only replaced
//! when the app next has something to save.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const FILE_NAME: &str = "desktop.json";
pub const SCHEMA: &str = "gnomon.desktop.settings/1";
pub const MAX_RECENT: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recent {
    pub path: PathBuf,
    /// Seconds since the Unix epoch.
    pub opened_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default = "schema")]
    pub schema: String,
    #[serde(default)]
    pub recent: Vec<Recent>,
    /// A gnomon executable the user chose with "Locate gnomon…".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gnomon: Option<PathBuf>,
}

fn schema() -> String {
    SCHEMA.to_string()
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            schema: schema(),
            recent: Vec::new(),
            gnomon: None,
        }
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

impl Settings {
    /// Read the file at `path`; anything wrong with it reads as empty.
    pub fn load(path: &Path) -> Settings {
        let Ok(text) = std::fs::read_to_string(path) else {
            return Settings::default();
        };
        let mut s: Settings = serde_json::from_str(&text).unwrap_or_default();
        s.recent.truncate(MAX_RECENT);
        s
    }

    /// Write to `path`, through a temporary file beside it and a rename, so a
    /// crash mid-write leaves the old file whole.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        let text = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        std::fs::write(&tmp, text + "\n")?;
        std::fs::rename(&tmp, path)
    }

    /// Put `root` first in the recent list.
    pub fn touch(&mut self, root: &Path, now: u64) {
        self.recent.retain(|r| !same_path(&r.path, root));
        self.recent.insert(
            0,
            Recent {
                path: root.to_path_buf(),
                opened_at: now,
            },
        );
        self.recent.truncate(MAX_RECENT);
    }

    /// Drop the entry at `index`, if there is one.
    pub fn forget(&mut self, index: usize) -> Option<Recent> {
        (index < self.recent.len()).then(|| self.recent.remove(index))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn touch_moves_to_front_without_duplicates_and_caps() {
        let mut s = Settings::default();
        for i in 0..(MAX_RECENT + 3) {
            s.touch(Path::new(&format!("/p/{i}")), i as u64);
        }
        assert_eq!(s.recent.len(), MAX_RECENT);
        assert_eq!(
            s.recent[0].path,
            Path::new(&format!("/p/{}", MAX_RECENT + 2))
        );
        s.touch(Path::new("/p/5"), 99);
        assert_eq!(
            s.recent[0],
            Recent {
                path: "/p/5".into(),
                opened_at: 99
            }
        );
        assert_eq!(
            s.recent
                .iter()
                .filter(|r| r.path == Path::new("/p/5"))
                .count(),
            1
        );
        assert_eq!(s.recent.len(), MAX_RECENT);
    }

    #[test]
    fn forget_by_index() {
        let mut s = Settings::default();
        s.touch(Path::new("/a"), 1);
        s.touch(Path::new("/b"), 2);
        assert_eq!(s.forget(5), None);
        assert_eq!(s.forget(0).unwrap().path, Path::new("/b"));
        assert_eq!(s.recent.len(), 1);
    }

    #[test]
    fn round_trips_and_writes_only_its_file() {
        let t = tempfile::tempdir().unwrap();
        let path = t.path().join("cfg").join(FILE_NAME);
        let mut s = Settings::default();
        s.touch(Path::new("/x/repo"), 1_700_000_000);
        s.gnomon = Some("/opt/gnomon/bin/gnomon".into());
        s.save(&path).unwrap();
        assert_eq!(Settings::load(&path), s);
        let names: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, [FILE_NAME]);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains(SCHEMA));
    }

    #[test]
    fn missing_or_corrupt_reads_as_empty() {
        let t = tempfile::tempdir().unwrap();
        assert_eq!(
            Settings::load(&t.path().join("nope.json")),
            Settings::default()
        );
        let bad = t.path().join(FILE_NAME);
        std::fs::write(&bad, "{ not json").unwrap();
        assert_eq!(Settings::load(&bad), Settings::default());
        std::fs::write(&bad, r#"{"recent": "wrong type"}"#).unwrap();
        assert_eq!(Settings::load(&bad), Settings::default());
    }

    #[test]
    fn an_older_or_partial_file_still_reads() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().join(FILE_NAME);
        std::fs::write(
            &p,
            r#"{"recent":[{"path":"/r","opened_at":5}],"future_field":true}"#,
        )
        .unwrap();
        let s = Settings::load(&p);
        assert_eq!(s.schema, SCHEMA);
        assert_eq!(s.recent.len(), 1);
        assert_eq!(s.gnomon, None);
    }
}
