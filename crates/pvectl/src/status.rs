// SPDX-License-Identifier: GPL-3.0-or-later
//! `pvectl status`: every server's nodes and guests, straight from Proxmox.

use std::path::Path;
use std::process::ExitCode;

use pve_core::Snapshot;
use pve_core::snapshot::GIB;
use serde_json::{Value, json};
use zbus::Connection;

struct ServerStatus {
    id: String,
    result: Result<Snapshot, String>,
    temp_error: Option<String>,
}

async fn fetch(conn: &Connection, server: &pve_core::config::Server) -> ServerStatus {
    let mut status = ServerStatus {
        id: server.id.clone(),
        result: Err(String::new()),
        temp_error: None,
    };
    let (api, temp) = match crate::clients(conn, server).await {
        Ok(c) => c,
        Err(e) => {
            status.result = Err(e);
            return status;
        }
    };
    let (resources, report) = tokio::join!(api.resources(), async {
        match &temp {
            Some(Ok(t)) => Some(t.report().await.map_err(|e| e.to_string())),
            Some(Err(e)) => Some(Err(e.clone())),
            None => None,
        }
    });
    let host_temp = match report {
        Some(Ok(r)) => r.host_temp(),
        Some(Err(e)) => {
            status.temp_error = Some(e);
            None
        }
        None => None,
    };
    status.result = resources
        .map(|r| Snapshot::build(&server.id, &r, host_temp.as_ref()))
        .map_err(|e| e.to_string());
    status
}

fn value(snap: &Snapshot, key: &str) -> Option<f64> {
    snap.values.get(key).copied()
}

fn pct(v: Option<f64>) -> String {
    v.map_or("--".to_owned(), |v| format!("{v:.0}%"))
}

fn print_text(statuses: &[ServerStatus]) {
    for (i, s) in statuses.iter().enumerate() {
        if i > 0 {
            println!();
        }
        let snap = match &s.result {
            Ok(snap) => snap,
            Err(e) => {
                println!("{}: {e}", s.id);
                continue;
            }
        };
        println!("{}", s.id);
        for n in &snap.nodes {
            let key = |m: &str| format!("{}/node/{}/{m}", s.id, n.name);
            if n.status != "online" {
                println!("  node {:<12} {}", n.name, n.status);
                continue;
            }
            let cpu = value(snap, &key("cpu")).map_or("--".to_owned(), |v| format!("{v:.1}%"));
            let mem = match (
                value(snap, &key("mem_used")),
                value(snap, &key("mem_total")),
            ) {
                (Some(u), Some(t)) => format!(
                    "{} ({:.1}/{:.1} GiB)",
                    pct(value(snap, &key("mem"))),
                    u / GIB,
                    t / GIB
                ),
                _ => pct(value(snap, &key("mem"))),
            };
            let temp =
                value(snap, &key("temp")).map_or(String::new(), |t| format!("  temp {t:.0}°C"));
            println!(
                "  node {:<12} cpu {cpu:>6}  ram {mem}  disk {}{temp}",
                n.name,
                pct(value(snap, &key("disk")))
            );
        }
        if let Some(e) = &s.temp_error {
            println!("  temperature: {e}");
        }
        let running = snap.guests.iter().filter(|g| g.status == "running").count();
        println!("  guests: {running} running / {}", snap.guests.len());
        for g in &snap.guests {
            let key = |m: &str| format!("{}/guest/{}/{m}", s.id, g.vmid);
            let usage = if g.status == "running" {
                format!(
                    "cpu {:>6}  ram {:>4}",
                    value(snap, &key("cpu")).map_or("--".to_owned(), |v| format!("{v:.1}%")),
                    pct(value(snap, &key("mem")))
                )
            } else {
                String::new()
            };
            println!(
                "    {:>6} {:<3} {:<20} {:<8} {:<10} {usage}",
                g.vmid,
                if g.kind == "lxc" { "CT" } else { "VM" },
                g.name,
                g.status,
                g.node
            );
        }
    }
}

fn to_json(statuses: &[ServerStatus]) -> Value {
    let servers: Vec<Value> = statuses
        .iter()
        .map(|s| match &s.result {
            Err(e) => json!({"server": s.id, "ok": false, "error": e}),
            Ok(snap) => json!({
                "server": s.id,
                "ok": true,
                "temperature_error": s.temp_error,
                "nodes": snap.nodes.iter().map(|n| json!({"name": n.name, "status": n.status})).collect::<Vec<_>>(),
                "guests": snap.guests.iter().map(|g| json!({
                    "vmid": g.vmid, "kind": g.kind, "node": g.node, "name": g.name, "status": g.status,
                })).collect::<Vec<_>>(),
                "values": snap.values,
            }),
        })
        .collect();
    json!({"schema": 1, "servers": servers})
}

pub async fn run(config_path: &Path, only: Option<&str>, json: bool) -> Result<ExitCode, String> {
    let config = crate::load_config(config_path)?;
    let servers = crate::select(&config, only)?;
    if servers.is_empty() {
        return Err("no servers configured; add one with: pvectl setup NAME".to_owned());
    }
    let conn = Connection::session()
        .await
        .map_err(|e| format!("no session bus (needed for the GNOME Keyring): {e}"))?;
    let statuses = futures_util::future::join_all(servers.iter().map(|s| fetch(&conn, s))).await;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&to_json(&statuses)).unwrap_or_default()
        );
    } else {
        print_text(&statuses);
    }
    Ok(if statuses.iter().all(|s| s.result.is_ok()) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}
