// SPDX-License-Identifier: GPL-3.0-or-later
//! `pvectl setup NAME`: adds or edits one server, interactively. Nothing is
//! saved until the token has been tried against the server.

use std::path::Path;
use std::process::ExitCode;

use pve_core::config::{self, Server, valid_server_id};
use pve_core::permissions;
use pve_sys::secret::{self, Key};
use pve_sys::tls::Trust;
use pve_sys::{FetchError, ProxmoxClient, TempClient, paths};
use zbus::Connection;

use crate::term::{ask, ask_secret, confirm};

const DEFAULT_TOKEN_ID: &str = "monitor@pve!pve-bar";

/// Decides how to trust the server: public CA if that works, else pin the
/// fingerprint after the user compares it with the Proxmox UI.
async fn choose_trust(server: &Server) -> Result<String, String> {
    let public = ProxmoxClient::with_trust(server, "x", Trust::PublicCa)?;
    match public.get("/version").await {
        Ok(_) | Err(FetchError::Unauthorized(_)) => {
            println!("The certificate is signed by a public CA; no pinning needed.");
            return Ok(String::new());
        }
        Err(FetchError::Tls(_)) => {}
        Err(e) => return Err(format!("cannot reach {}: {e}", server.url)),
    }
    let probe = ProxmoxClient::with_trust(server, "x", Trust::Capture)?;
    let _ = probe.get("/version").await;
    let fp = probe
        .seen_fingerprint()
        .ok_or_else(|| format!("{} did not present a certificate", server.url))?;
    if !server.fingerprint.is_empty() && server.fingerprint == fp {
        println!("The certificate still matches the pinned fingerprint.");
        return Ok(fp);
    }
    println!();
    println!("The server presents a certificate that is not from a public CA (Proxmox's");
    println!("own self-signed one, usually). Its SHA-256 fingerprint is:");
    println!();
    println!("  {fp}");
    println!();
    println!("Compare it with Proxmox → your node → System → Certificates → pve-ssl.pem");
    println!(
        "(or on the host: openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256)."
    );
    if !confirm("Do they match?", false)? {
        return Err("not trusting the certificate; nothing was saved".to_owned());
    }
    Ok(fp)
}

pub async fn run(config_path: &Path, name: &str) -> Result<ExitCode, String> {
    if !valid_server_id(name) {
        return Err(format!(
            "{name:?} is not a valid server name: use 1-32 characters of a-z, 0-9 and -"
        ));
    }
    let mut cfg = paths::load(config_path)?.unwrap_or_default();
    let existing = cfg.server(name).cloned();
    let conn = Connection::session()
        .await
        .map_err(|e| format!("no session bus (needed for the GNOME Keyring): {e}"))?;
    match &existing {
        Some(_) => println!("Editing server {name}. Press Enter to keep a value."),
        None => println!("Adding server {name}."),
    }
    let old = existing.clone().unwrap_or_default();

    let mut server = Server {
        id: name.to_owned(),
        url: config::normalize_url(&ask("Proxmox URL (https://host:8006)", &old.url)?)?,
        token_id: ask(
            "API token id (user@realm!token)",
            if old.token_id.is_empty() {
                DEFAULT_TOKEN_ID
            } else {
                &old.token_id
            },
        )?,
        fingerprint: old.fingerprint.clone(),
        temp_url: old.temp_url.clone(),
    };
    server.validate()?;
    server.fingerprint = choose_trust(&server).await?;

    let old_secret = secret::lookup(&conn, &Key::ApiToken { server: name }, true).await?;
    let typed = ask_secret(if old_secret.is_some() {
        "API token secret (Enter keeps the stored one)"
    } else {
        "API token secret (the UUID shown once when the token was created)"
    })?;
    let token = match (typed.is_empty(), &old_secret) {
        (false, _) => typed,
        (true, Some(old)) => old.clone(),
        (true, None) => return Err("no token secret given; nothing was saved".to_owned()),
    };

    let api = ProxmoxClient::new(&server, &token)?;
    let resources = api
        .resources()
        .await
        .map_err(|e| format!("{e}; nothing was saved"))?;
    let guests = resources
        .iter()
        .filter(|r| r.kind == "qemu" || r.kind == "lxc")
        .count();
    let nodes = resources.iter().filter(|r| r.kind == "node").count();
    println!("Token works: {nodes} node(s), {guests} guest(s).");
    match api
        .get("/access/permissions")
        .await
        .map_err(|e| e.to_string())
        .and_then(|b| permissions::parse(&b))
    {
        Ok(p) if !p.writable.is_empty() => {
            let list: Vec<_> = p.writable.iter().map(String::as_str).collect();
            println!(
                "warning: this token can change things ({}).",
                list.join(", ")
            );
            println!("         pve-bar only reads; a token with only PVEAuditor is safer.");
        }
        Ok(p) if !p.missing().is_empty() => {
            println!(
                "warning: the token lacks {}, so pve-bar would show nothing.",
                p.missing().join(" and ")
            );
            println!("         A privilege-separated token gets only what its user also has.");
            println!(
                "         On the host run: {}",
                permissions::grant_command(&server.token_id)
            );
        }
        _ => {}
    }

    println!();
    println!(
        "Optional: pve-temp-agent on this host shows its temperature (see deploy/pve-temp-agent)."
    );
    let temp_url = ask(
        "Temperature agent URL (http://host:9101, '-' for none)",
        &old.temp_url,
    )?;
    server.temp_url = if temp_url == "-" {
        String::new()
    } else {
        temp_url
    };
    server.validate()?;
    let mut temp_token = None;
    if !server.temp_url.is_empty() {
        let old_temp = secret::lookup(&conn, &Key::TempAgent { server: name }, true).await?;
        let typed = ask_secret(if old_temp.is_some() {
            "Agent token (Enter keeps the stored one)"
        } else {
            "Agent token (printed by install-agent.sh; /etc/pve-temp-agent/token on the host)"
        })?;
        let t = match (typed.is_empty(), old_temp) {
            (false, _) => typed,
            (true, Some(old)) => old,
            (true, None) => return Err("no agent token given; nothing was saved".to_owned()),
        };
        match TempClient::new(&server.temp_url, &t)?.report().await {
            Ok(r) => match r.host_temp() {
                Some(h) => println!("Agent works: node {} at {:.0}°C.", h.node, h.celsius),
                None => println!("warning: the agent answers but reports no sensors."),
            },
            Err(e) => {
                println!("warning: the agent does not answer yet: {e}");
                if !confirm("Save it anyway?", false)? {
                    return Err("nothing was saved".to_owned());
                }
            }
        }
        temp_token = Some(t);
    }

    secret::store(&conn, &Key::ApiToken { server: name }, &token).await?;
    match &temp_token {
        Some(t) => secret::store(&conn, &Key::TempAgent { server: name }, t).await?,
        None => secret::delete(&conn, &Key::TempAgent { server: name }).await?,
    }
    cfg.upsert(server);
    paths::save(config_path, &cfg)?;
    crate::reload_pved();
    println!();
    println!(
        "Saved {name} to {} and its token(s) to the GNOME Keyring.",
        config_path.display()
    );
    println!("Check everything with: pvectl doctor");
    Ok(ExitCode::SUCCESS)
}
