// SPDX-License-Identifier: GPL-3.0-or-later
//! `pvectl doctor`: read-only checks of the whole chain, from the config
//! file to the extension. It never changes anything; when something is wrong
//! it prints what to run. Exits with 1 when something needs attention.

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use pve_core::config::Server;
use pve_core::permissions;
use pve_sys::secret::{self, Key};
use pve_sys::tls::Trust;
use pve_sys::{FetchError, ProxmoxClient, paths};
use zbus::Connection;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Level {
    Ok,
    Warn,
    Fail,
}

struct Report {
    worst: Level,
}

impl Report {
    fn line(&mut self, level: Level, name: &str, detail: &str) {
        let tag = match level {
            Level::Ok => "[ ok ]",
            Level::Warn => "[warn]",
            Level::Fail => "[FAIL]",
        };
        println!("{tag} {name:<22} {detail}");
        if level as u8 > self.worst as u8 {
            self.worst = level;
        }
    }

    fn fix(&self, text: &str) {
        println!("       {:<22} → {text}", "");
    }
}

/// The fingerprint the server presents, for a fix suggestion.
async fn presented_fingerprint(server: &Server) -> Option<String> {
    let probe = ProxmoxClient::with_trust(server, "x", Trust::Capture).ok()?;
    let _ = probe.get("/version").await;
    probe.seen_fingerprint()
}

async fn check_server(r: &mut Report, conn: Option<&Connection>, server: &Server) {
    let name = |what: &str| format!("{}: {what}", server.id);
    let Some(conn) = conn else {
        r.line(
            Level::Fail,
            &name("keyring"),
            "no session bus, cannot read the token",
        );
        return;
    };
    let token = match secret::lookup(conn, &Key::ApiToken { server: &server.id }, true).await {
        Ok(Some(t)) => {
            r.line(
                Level::Ok,
                &name("token"),
                &format!("{} found in the GNOME Keyring", server.token_id),
            );
            t
        }
        Ok(None) => {
            r.line(
                Level::Fail,
                &name("token"),
                "no API token in the GNOME Keyring",
            );
            r.fix(&format!("pvectl setup {}", server.id));
            return;
        }
        Err(e) => {
            r.line(Level::Fail, &name("token"), &e);
            return;
        }
    };
    let api = match ProxmoxClient::new(server, &token) {
        Ok(api) => api,
        Err(e) => {
            r.line(Level::Fail, &name("api"), &e);
            return;
        }
    };
    match api.get("/version").await {
        Ok(body) => {
            let version = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|v| v["data"]["version"].as_str().map(str::to_owned))
                .unwrap_or_else(|| "?".to_owned());
            let trust = if server.fingerprint.is_empty() {
                "public CA"
            } else {
                "pinned certificate"
            };
            r.line(
                Level::Ok,
                &name("api"),
                &format!("{} answers, Proxmox VE {version} ({trust})", server.url),
            );
        }
        Err(FetchError::Tls(e)) => {
            r.line(Level::Fail, &name("tls"), &e);
            if let Some(fp) = presented_fingerprint(server).await {
                if server.fingerprint.is_empty() {
                    r.fix(&format!(
                        "the certificate is not from a public CA (self-signed?). It is {fp}"
                    ));
                } else {
                    r.fix(&format!(
                        "the server now presents {fp} (certificate renewed?)"
                    ));
                }
                r.fix(&format!(
                    "compare with Proxmox → Node → System → Certificates, then: pvectl setup {}",
                    server.id
                ));
            }
            return;
        }
        Err(FetchError::Unauthorized(e)) => {
            r.line(Level::Fail, &name("api"), &e);
            r.fix("check the token id and secret, and that the token is not expired or revoked");
            r.fix(&format!("then: pvectl setup {}", server.id));
            return;
        }
        Err(e) => {
            r.line(Level::Fail, &name("api"), e.message());
            r.fix(&format!(
                "is {} reachable from here? (port 8006)",
                server.url
            ));
            return;
        }
    }
    match api
        .get("/access/permissions")
        .await
        .map_err(|e| e.to_string())
        .and_then(|b| permissions::parse(&b))
    {
        Ok(p) if !p.can_read_nodes() || !p.can_read_guests() => {
            r.line(
                Level::Fail,
                &name("privileges"),
                "the token cannot read nodes (Sys.Audit) or guests (VM.Audit)",
            );
            r.fix("give the user and the token the PVEAuditor role on /: Datacenter → Permissions → Add");
        }
        Ok(p) if !p.writable.is_empty() => {
            let list: Vec<_> = p.writable.iter().map(String::as_str).collect();
            r.line(
                Level::Warn,
                &name("privileges"),
                &format!("the token can change things: {}", list.join(", ")),
            );
            r.fix("pve-bar only reads; use a token with only the PVEAuditor role");
        }
        Ok(_) => r.line(
            Level::Ok,
            &name("privileges"),
            "read-only (Audit privileges only)",
        ),
        Err(e) => r.line(Level::Warn, &name("privileges"), &e),
    }
    if server.temp_url.is_empty() {
        r.line(
            Level::Ok,
            &name("temperature"),
            "no agent configured (optional)",
        );
        return;
    }
    match crate::clients(conn, server).await {
        Ok((_, Some(Ok(t)))) => match t.report().await {
            Ok(rep) => match rep.host_temp() {
                Some(h) => r.line(
                    Level::Ok,
                    &name("temperature"),
                    &format!(
                        "{}: node {} at {:.0}°C ({} sensors)",
                        server.temp_url,
                        h.node,
                        h.celsius,
                        rep.sensors.len()
                    ),
                ),
                None => r.line(
                    Level::Warn,
                    &name("temperature"),
                    "the agent answers but reports no sensors",
                ),
            },
            Err(e) => {
                r.line(Level::Fail, &name("temperature"), e.message());
                if matches!(e, FetchError::Unauthorized(_)) {
                    r.fix(&format!("the agent token differs; see /etc/pve-temp-agent/token on the host, then: pvectl setup {}", server.id));
                } else {
                    r.fix("on the host: systemctl status pve-temp-agent; is port 9101 open to this machine?");
                }
            }
        },
        Ok((_, Some(Err(e)))) => {
            r.line(Level::Fail, &name("temperature"), &e);
        }
        Ok((_, None)) => {}
        Err(e) => r.line(Level::Fail, &name("temperature"), &e),
    }
}

#[zbus::proxy(
    interface = "io.github.pauloeduardods.PveBar1",
    default_service = "io.github.pauloeduardods.PveBar1",
    default_path = "/io/github/pauloeduardods/PveBar1"
)]
trait PveBar {
    #[zbus(property)]
    fn version(&self) -> zbus::Result<String>;
    #[zbus(property)]
    fn servers(&self) -> zbus::Result<Vec<(String, String, String)>>;
    #[zbus(property)]
    fn config_error(&self) -> zbus::Result<String>;
}

async fn check_pved(r: &mut Report, conn: Option<&Connection>) {
    let Some(conn) = conn else {
        r.line(Level::Fail, "pved", "no session bus");
        return;
    };
    // Reading a property starts pved through D-Bus activation if needed.
    let result = async {
        let p = PveBarProxy::new(conn).await?;
        Ok::<_, zbus::Error>((
            p.version().await?,
            p.servers().await?,
            p.config_error().await?,
        ))
    }
    .await;
    match result {
        Ok((version, servers, config_error)) => {
            r.line(Level::Ok, "pved", &format!("running, version {version}"));
            if !config_error.is_empty() {
                r.line(Level::Fail, "pved: config", &config_error);
            }
            for (id, state, message) in servers {
                let level = match state.as_str() {
                    "ok" | "connecting" => Level::Ok,
                    _ => Level::Warn,
                };
                let detail = if message.is_empty() {
                    state
                } else {
                    format!("{state}: {message}")
                };
                r.line(level, &format!("pved: {id}"), &detail);
            }
        }
        Err(e) => {
            r.line(
                Level::Fail,
                "pved",
                &format!("not reachable on the session bus: {e}"),
            );
            r.fix("journalctl --user -u pved; reinstall with ./install.sh");
        }
    }
}

fn check_extension(r: &mut Report) {
    let data = std::env::var_os("XDG_DATA_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/share")
        });
    let meta = data.join("gnome-shell/extensions/pve-bar@paulo/metadata.json");
    if meta.exists() {
        r.line(
            Level::Ok,
            "extension",
            "installed (gnome-extensions info pve-bar@paulo)",
        );
    } else {
        r.line(Level::Warn, "extension", "not installed for this user");
        r.fix("./install.sh");
    }
}

pub async fn run(config_path: &Path, only: Option<&str>) -> Result<ExitCode, String> {
    let mut r = Report { worst: Level::Ok };
    let conn = Connection::session().await.ok();
    match paths::load(config_path) {
        Ok(Some(config)) if config.servers.is_empty() => {
            r.line(
                Level::Fail,
                "config",
                &format!("{} has no servers", config_path.display()),
            );
            r.fix("pvectl setup NAME");
        }
        Ok(Some(config)) => {
            let servers = crate::select(&config, only)?;
            let names: Vec<_> = config.servers.iter().map(|s| s.id.as_str()).collect();
            r.line(
                Level::Ok,
                "config",
                &format!("{}: {}", config_path.display(), names.join(", ")),
            );
            for server in servers {
                check_server(&mut r, conn.as_ref(), server).await;
            }
        }
        Ok(None) => {
            r.line(
                Level::Fail,
                "config",
                &format!("no {}", config_path.display()),
            );
            r.fix("pvectl setup NAME   (NAME is any short name for the server, e.g. home)");
        }
        Err(e) => r.line(Level::Fail, "config", &e),
    }
    check_pved(&mut r, conn.as_ref()).await;
    check_extension(&mut r);
    println!();
    if r.worst == Level::Ok {
        println!("Nothing to fix.");
        Ok(ExitCode::SUCCESS)
    } else {
        println!("Something needs attention; see the lines above.");
        Ok(ExitCode::FAILURE)
    }
}
