//! The project folder the user picked, made into the `--dir` the dashboard gets.
//!
//! `gnomon dashboard` run from a folder treats the nearest directory at or
//! above it that holds `.gnomon` as "here" (dashboard_data.ts,
//! `projectRootAbove`). The app resolves the same root itself and passes it
//! as `--dir`, so picking `repo/src` opens `repo`, as the CLI would. A folder
//! with no `.gnomon` above it is passed as it is, so it still shows as the
//! dashboard's project ("no .gnomon/ yet") instead of disappearing.

use std::path::{Path, PathBuf};

/// A folder ready to open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Project {
    /// What the dashboard gets as `--dir`.
    pub root: PathBuf,
    /// The folder's name, for the window title and the recent list.
    pub name: String,
    /// Whether `root` holds a `.gnomon`.
    pub has_surface: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectError {
    Missing(PathBuf),
    NotAFolder(PathBuf),
}

impl std::fmt::Display for ProjectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProjectError::Missing(p) => {
                write!(f, "{} does not exist (moved or deleted?)", p.display())
            }
            ProjectError::NotAFolder(p) => write!(f, "{} is not a folder", p.display()),
        }
    }
}

/// `\\?\C:\x` -> `C:\x` and `\\?\UNC\srv\share` -> `\\srv\share`: what
/// `canonicalize` returns on Windows is a verbatim path, which node and the
/// user would both read badly. Other paths are returned unchanged.
pub fn simplify_verbatim(p: &str) -> String {
    if let Some(rest) = p.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = p.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            return rest.to_string();
        }
    }
    p.to_string()
}

/// The real path, symlinks resolved (the dashboard keys projects by realpath).
pub fn real(p: &Path) -> std::io::Result<PathBuf> {
    let c = std::fs::canonicalize(p)?;
    Ok(if cfg!(windows) {
        PathBuf::from(simplify_verbatim(&c.to_string_lossy()))
    } else {
        c
    })
}

/// The nearest directory at or above `start` that holds `.gnomon`, as the
/// dashboard's `projectRootAbove` finds it.
pub fn root_above(start: &Path) -> Option<PathBuf> {
    start
        .ancestors()
        .find(|d| d.join(".gnomon").exists())
        .map(Path::to_path_buf)
}

/// The name shown for a folder: its last component, or the whole path for a
/// root like `/` or `C:\`.
pub fn display_name(p: &Path) -> String {
    p.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.display().to_string())
}

/// Turn a picked folder into a project.
pub fn open_folder(picked: &Path) -> Result<Project, ProjectError> {
    if !picked.exists() {
        return Err(ProjectError::Missing(picked.to_path_buf()));
    }
    let real = real(picked).map_err(|_| ProjectError::Missing(picked.to_path_buf()))?;
    if !real.is_dir() {
        return Err(ProjectError::NotAFolder(real));
    }
    let (root, has_surface) = match root_above(&real) {
        Some(r) => (r, true),
        None => (real, false),
    };
    Ok(Project {
        name: display_name(&root),
        root,
        has_surface,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbatim_paths_are_simplified() {
        assert_eq!(
            simplify_verbatim(r"\\?\C:\Users\u\repo"),
            r"C:\Users\u\repo"
        );
        assert_eq!(
            simplify_verbatim(r"\\?\UNC\srv\share\repo"),
            r"\\srv\share\repo"
        );
        assert_eq!(
            simplify_verbatim(r"\\?\Volume{abc}\x"),
            r"\\?\Volume{abc}\x"
        );
        assert_eq!(simplify_verbatim("/home/u/repo"), "/home/u/repo");
        assert_eq!(simplify_verbatim(r"C:\x"), r"C:\x");
    }

    #[test]
    fn a_subfolder_opens_its_project() {
        let t = tempfile::tempdir().unwrap();
        let repo = t.path().join("repo");
        std::fs::create_dir_all(repo.join(".gnomon")).unwrap();
        std::fs::create_dir_all(repo.join("src").join("deep")).unwrap();
        let p = open_folder(&repo.join("src").join("deep")).unwrap();
        assert_eq!(p.root, real(&repo).unwrap());
        assert_eq!(p.name, "repo");
        assert!(p.has_surface);
    }

    #[test]
    fn a_folder_without_a_surface_opens_as_itself() {
        let t = tempfile::tempdir().unwrap();
        let fresh = t.path().join("fresh");
        std::fs::create_dir_all(&fresh).unwrap();
        let p = open_folder(&fresh).unwrap();
        // Unless some ancestor of the temp dir holds a .gnomon, which a test
        // machine should not.
        if root_above(&real(&fresh).unwrap()).is_none() {
            assert_eq!(p.root, real(&fresh).unwrap());
            assert!(!p.has_surface);
            assert_eq!(p.name, "fresh");
        }
    }

    #[test]
    fn a_file_or_a_missing_path_is_refused() {
        let t = tempfile::tempdir().unwrap();
        let f = t.path().join("file.txt");
        std::fs::write(&f, "x").unwrap();
        assert!(matches!(open_folder(&f), Err(ProjectError::NotAFolder(_))));
        assert!(matches!(
            open_folder(&t.path().join("nope")),
            Err(ProjectError::Missing(_))
        ));
    }

    #[test]
    fn a_gnomon_file_counts_like_the_cli_counts_it() {
        // projectRootAbove uses existsSync: a file named .gnomon counts too.
        let t = tempfile::tempdir().unwrap();
        std::fs::write(t.path().join(".gnomon"), "").unwrap();
        assert_eq!(root_above(t.path()), Some(t.path().to_path_buf()));
    }

    #[test]
    fn names() {
        assert_eq!(display_name(Path::new("/a/b/repo")), "repo");
        assert_eq!(display_name(Path::new("/")), "/");
    }
}
