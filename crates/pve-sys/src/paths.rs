// SPDX-License-Identifier: GPL-3.0-or-later
//! Where the config file lives, and reading and writing it.

use std::fs;
use std::io::Write as _;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use pve_core::config::Config;

/// `$XDG_CONFIG_HOME/pve-bar/pved.conf`, else `~/.config/pve-bar/pved.conf`.
pub fn config_path() -> PathBuf {
    let base = std::env::var_os("XDG_CONFIG_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".config")
        });
    base.join("pve-bar").join("pved.conf")
}

/// Ok(None) when the file does not exist yet.
pub fn load(path: &Path) -> Result<Option<Config>, String> {
    match fs::read_to_string(path) {
        Ok(text) => Config::parse(&text)
            .map(Some)
            .map_err(|e| format!("{}: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("cannot read {}: {e}", path.display())),
    }
}

/// Writes atomically (temporary file + rename), mode 0600.
pub fn save(path: &Path, config: &Config) -> Result<(), String> {
    let dir = path.parent().ok_or("config path has no parent")?;
    fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    let tmp = path.with_extension("conf.tmp");
    let result = (|| {
        let mut f = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(config.render().as_bytes())?;
        f.sync_all()?;
        fs::rename(&tmp, path)
    })();
    result.map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("cannot write {}: {e}", path.display())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pve_core::config::Server;

    #[test]
    fn save_and_load() {
        let dir = std::env::temp_dir().join(format!("pve-sys-paths-{}", std::process::id()));
        let path = dir.join("pve-bar").join("pved.conf");
        assert_eq!(load(&path), Ok(None));
        let c = Config {
            servers: vec![Server {
                id: "pve".into(),
                url: "https://h:8006".into(),
                token_id: "a@pve!b".into(),
                ..Server::default()
            }],
        };
        save(&path, &c).unwrap();
        assert_eq!(load(&path), Ok(Some(c)));
        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        fs::write(&path, "nonsense").unwrap();
        assert!(load(&path).unwrap_err().contains("pved.conf"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
