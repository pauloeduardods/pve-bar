// SPDX-License-Identifier: GPL-3.0-or-later
//! `~/.config/pve-bar/pved.conf`: one `[name]` section per Proxmox server,
//! `key = value` lines, `#` comments. Several independent servers (or
//! clusters) can be watched at once; the section name identifies each one in
//! D-Bus keys and in the keyring. Never holds a secret: the token secrets live
//! in the GNOME Keyring.
//!
//! ```ini
//! [home]
//! url = https://pve.lan:8006
//! token_id = monitor@pve!pve-bar
//! fingerprint = AB:CD:...
//! temp_url = http://pve.lan:9101
//!
//! [lab]
//! url = https://lab.lan:8006
//! token_id = monitor@pve!pve-bar
//! ```

use std::fmt::Write as _;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Server {
    /// The section name: `[a-z0-9-]`, 1 to 32 characters.
    pub id: String,
    /// `https://pve.lan:8006`, without `/api2/json`.
    pub url: String,
    /// `monitor@pve!pve-bar`
    pub token_id: String,
    /// SHA-256 of the server certificate, upper-case hex with colons; empty
    /// means "trust the public CAs".
    pub fingerprint: String,
    /// `http://pve.lan:9101`; empty when there is no temperature agent.
    pub temp_url: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Config {
    /// In file order.
    pub servers: Vec<Server>,
}

/// Normalizes a fingerprint to `AB:CD:...` (accepts any case, with or
/// without colons). Returns None unless it is exactly 32 bytes of hex.
pub fn normalize_fingerprint(input: &str) -> Option<String> {
    let hex: String = input
        .chars()
        .filter(|c| !matches!(c, ':' | ' '))
        .collect::<String>()
        .to_ascii_uppercase();
    if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut out = String::with_capacity(95);
    for (i, pair) in hex.as_bytes().chunks(2).enumerate() {
        if i > 0 {
            out.push(':');
        }
        out.push(pair[0] as char);
        out.push(pair[1] as char);
    }
    Some(out)
}

/// `https://host:8006/`, `https://host:8006/api2/json` → `https://host:8006`.
pub fn normalize_url(input: &str) -> Result<String, String> {
    let mut url = input.trim().trim_end_matches('/').to_owned();
    if let Some(stripped) = url.strip_suffix("/api2/json") {
        url = stripped.to_owned();
    }
    if !url.starts_with("https://") {
        return Err(format!(
            "url must start with https:// (Proxmox only serves its API over HTTPS): {input}"
        ));
    }
    if url.len() <= "https://".len() {
        return Err("url has no host".to_owned());
    }
    Ok(url)
}

pub fn valid_server_id(id: &str) -> bool {
    (1..=32).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
}

fn valid_token_id(id: &str) -> bool {
    // user@realm!tokenname
    let Some((user, token)) = id.split_once('!') else {
        return false;
    };
    user.contains('@') && !token.is_empty() && !id.chars().any(char::is_whitespace)
}

impl Server {
    pub fn validate(&mut self) -> Result<(), String> {
        let id = self.id.clone();
        let ctx = |e: String| format!("[{id}]: {e}");
        if !valid_server_id(&self.id) {
            return Err(format!(
                "server name {:?} must be 1-32 characters of a-z, 0-9 and -",
                self.id
            ));
        }
        if self.url.is_empty() {
            return Err(ctx("url is missing".to_owned()));
        }
        self.url = normalize_url(&self.url).map_err(ctx)?;
        if !valid_token_id(&self.token_id) {
            return Err(ctx(format!(
                "token_id must look like user@realm!name, got {:?}",
                self.token_id
            )));
        }
        if !self.fingerprint.is_empty() {
            self.fingerprint = normalize_fingerprint(&self.fingerprint).ok_or_else(|| {
                ctx("fingerprint must be a SHA-256 fingerprint (64 hex digits)".to_owned())
            })?;
        }
        self.temp_url = self.temp_url.trim_end_matches('/').to_owned();
        if !self.temp_url.is_empty()
            && !(self.temp_url.starts_with("http://") || self.temp_url.starts_with("https://"))
        {
            return Err(ctx(
                "temp_url must start with http:// or https://".to_owned()
            ));
        }
        Ok(())
    }
}

impl Config {
    pub fn parse(text: &str) -> Result<Self, String> {
        let mut c = Config::default();
        for (n, raw) in text.lines().enumerate() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
                let id = name.trim().to_owned();
                if c.servers.iter().any(|s| s.id == id) {
                    return Err(format!("line {}: server [{id}] appears twice", n + 1));
                }
                c.servers.push(Server {
                    id,
                    ..Server::default()
                });
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                return Err(format!("line {}: expected key = value or [name]", n + 1));
            };
            let Some(server) = c.servers.last_mut() else {
                return Err(format!(
                    "line {}: {} comes before any [server] section",
                    n + 1,
                    key.trim()
                ));
            };
            let value = value.trim().to_owned();
            match key.trim() {
                "url" => server.url = value,
                "token_id" => server.token_id = value,
                "fingerprint" => server.fingerprint = value,
                "temp_url" => server.temp_url = value,
                other => return Err(format!("line {}: unknown key {other:?}", n + 1)),
            }
        }
        for s in &mut c.servers {
            s.validate()?;
        }
        Ok(c)
    }

    pub fn server(&self, id: &str) -> Option<&Server> {
        self.servers.iter().find(|s| s.id == id)
    }

    /// Adds `server`, or replaces the one with the same id in place.
    pub fn upsert(&mut self, server: Server) {
        match self.servers.iter_mut().find(|s| s.id == server.id) {
            Some(existing) => *existing = server,
            None => self.servers.push(server),
        }
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.servers.len();
        self.servers.retain(|s| s.id != id);
        self.servers.len() != before
    }

    pub fn render(&self) -> String {
        let mut s = String::from(
            "# pve-bar: written by `pvectl setup`. One [name] section per Proxmox server.\n\
             # The token secrets are in the GNOME Keyring, never here.\n",
        );
        for server in &self.servers {
            let _ = writeln!(s, "\n[{}]", server.id);
            let _ = writeln!(s, "url = {}", server.url);
            let _ = writeln!(s, "token_id = {}", server.token_id);
            let _ = writeln!(
                s,
                "# SHA-256 of the server certificate; empty: trust the public CAs"
            );
            let _ = writeln!(s, "fingerprint = {}", server.fingerprint);
            let _ = writeln!(s, "# pve-temp-agent on the host; empty: no temperature");
            let _ = writeln!(s, "temp_url = {}", server.temp_url);
        }
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FP: &str = "ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89";

    #[test]
    fn parses_several_servers_and_normalizes() {
        let text = format!(
            "# comment\n\n[home]\nurl = https://pve.lan:8006/api2/json/\ntoken_id = monitor@pve!pve-bar\nfingerprint = {FP}\ntemp_url = http://pve.lan:9101/\n\n[lab-2]\nurl = https://lab:8006\ntoken_id = monitor@pve!pve-bar\n"
        );
        let c = Config::parse(&text).unwrap();
        assert_eq!(c.servers.len(), 2);
        let home = c.server("home").unwrap();
        assert_eq!(home.url, "https://pve.lan:8006");
        assert_eq!(home.token_id, "monitor@pve!pve-bar");
        assert!(home.fingerprint.starts_with("AB:CD:EF:01"));
        assert_eq!(home.temp_url, "http://pve.lan:9101");
        assert_eq!(c.servers[1].id, "lab-2");
        assert_eq!(c.servers[1].temp_url, "");
    }

    #[test]
    fn round_trips() {
        let c = Config {
            servers: vec![
                Server {
                    id: "a".into(),
                    url: "https://h:8006".into(),
                    token_id: "a@pve!b".into(),
                    fingerprint: normalize_fingerprint(FP).unwrap(),
                    temp_url: String::new(),
                },
                Server {
                    id: "b".into(),
                    url: "https://i:8006".into(),
                    token_id: "a@pve!b".into(),
                    fingerprint: String::new(),
                    temp_url: "http://i:9101".into(),
                },
            ],
        };
        assert_eq!(Config::parse(&c.render()).unwrap(), c);
        assert_eq!(
            Config::parse(&Config::default().render()).unwrap(),
            Config::default()
        );
    }

    #[test]
    fn upsert_and_remove() {
        let mut c = Config::default();
        let s = |id: &str, url: &str| Server {
            id: id.into(),
            url: url.into(),
            ..Server::default()
        };
        c.upsert(s("a", "1"));
        c.upsert(s("b", "2"));
        c.upsert(s("a", "3"));
        assert_eq!(c.servers.len(), 2);
        assert_eq!(c.servers[0].url, "3");
        assert!(c.remove("a"));
        assert!(!c.remove("a"));
        assert_eq!(c.servers[0].id, "b");
    }

    #[test]
    fn rejects_bad_input() {
        let ok = "[pve]\nurl = https://h:8006\ntoken_id = a@pve!b\n";
        assert!(Config::parse(ok).is_ok());
        assert!(
            Config::parse("url = https://h:8006")
                .unwrap_err()
                .contains("before any")
        );
        assert!(
            Config::parse(&format!("{ok}{ok}"))
                .unwrap_err()
                .contains("twice")
        );
        assert!(Config::parse("[Bad Name]\nurl = https://h\ntoken_id = a@pve!b").is_err());
        assert!(Config::parse("[p]\nurl = http://h:8006\ntoken_id = a@pve!b").is_err());
        assert!(Config::parse("[p]\ntoken_id = a@pve!b").is_err());
        assert!(Config::parse("[p]\nurl = https://h\ntoken_id = a@pve").is_err());
        assert!(Config::parse(&format!("{ok}fingerprint = 12:34")).is_err());
        assert!(Config::parse(&format!("{ok}temp_url = ftp://x")).is_err());
        assert!(Config::parse(&format!("{ok}password = hunter2")).is_err());
        assert!(Config::parse(&format!("{ok}garbage")).is_err());
    }

    #[test]
    fn server_ids() {
        assert!(valid_server_id("home"));
        assert!(valid_server_id("lab-2"));
        assert!(!valid_server_id(""));
        assert!(!valid_server_id("-x"));
        assert!(!valid_server_id("a/b"));
        assert!(!valid_server_id(&"x".repeat(33)));
    }

    #[test]
    fn fingerprint_forms() {
        let plain: String = FP.replace(':', "");
        assert_eq!(normalize_fingerprint(&plain), normalize_fingerprint(FP));
        assert_eq!(normalize_fingerprint("zz"), None);
    }
}
