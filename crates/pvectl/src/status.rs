// SPDX-License-Identifier: GPL-3.0-or-later
//! `pvectl status`: every server's nodes and guests, straight from Proxmox.
//! With `--watch` it polls every 10 s and draws the last minutes as text
//! sparklines.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::io::Write as _;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use pve_core::Snapshot;
use pve_core::backoff;
use pve_core::history::History;
use pve_core::snapshot::GIB;
use serde_json::{Value, json};
use zbus::Connection;

/// Samples per sparkline: 5 minutes at 10 s.
const WATCH_WIDTH: usize = 30;
const BLOCKS: [char; 8] = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

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

/// One character per value, scaled between the lowest and highest value
/// shown; a gap is a space.
fn sparkline(values: &[f64]) -> String {
    let known = values.iter().filter(|v| v.is_finite());
    let low = known.clone().copied().fold(f64::INFINITY, f64::min);
    let high = known.copied().fold(f64::NEG_INFINITY, f64::max);
    values
        .iter()
        .map(|v| match v {
            v if !v.is_finite() => ' ',
            _ if high <= low => BLOCKS[BLOCKS.len() / 2],
            v => {
                let step = ((v - low) / (high - low) * (BLOCKS.len() - 1) as f64).round();
                BLOCKS[step as usize]
            }
        })
        .collect()
}

/// What `--watch` draws the graphs from.
struct Graphs<'a> {
    history: &'a History,
    now: f64,
}

impl Graphs<'_> {
    /// The last [`WATCH_WIDTH`] samples of `key`, if any is known.
    fn recent(&self, key: &str) -> Option<Vec<f64>> {
        let (_, values) = self
            .history
            .query(&[key.to_owned()], self.now)
            .remove(key)?;
        let start = values.len().saturating_sub(WATCH_WIDTH);
        let recent = values[start..].to_vec();
        recent.iter().any(|v| v.is_finite()).then_some(recent)
    }

    /// `cpu %  ▁▃▅█  3–40` under a node.
    fn line(&self, out: &mut String, label: &str, key: &str) {
        let Some(values) = self.recent(key) else {
            return;
        };
        let known = values.iter().copied().filter(|v| v.is_finite());
        let low = known.clone().fold(f64::INFINITY, f64::min);
        let high = known.fold(f64::NEG_INFINITY, f64::max);
        let _ = writeln!(
            out,
            "         {label:<7}{:<width$}  {low:.0}–{high:.0}",
            sparkline(&values),
            width = WATCH_WIDTH
        );
    }
}

fn render_text(statuses: &[ServerStatus], graphs: Option<&Graphs<'_>>) -> String {
    let mut out = String::new();
    for (i, s) in statuses.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let snap = match &s.result {
            Ok(snap) => snap,
            Err(e) => {
                let _ = writeln!(out, "{}: {e}", s.id);
                continue;
            }
        };
        let _ = writeln!(out, "{}", s.id);
        for n in &snap.nodes {
            let key = |m: &str| format!("{}/node/{}/{m}", s.id, n.name);
            if n.status != "online" {
                let _ = writeln!(out, "  node {:<12} {}", n.name, n.status);
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
            let _ = writeln!(
                out,
                "  node {:<12} cpu {cpu:>6}  ram {mem}  disk {}{temp}",
                n.name,
                pct(value(snap, &key("disk")))
            );
            if let Some(g) = graphs {
                g.line(&mut out, "cpu %", &key("cpu"));
                g.line(&mut out, "ram %", &key("mem"));
                g.line(&mut out, "temp °C", &key("temp"));
            }
        }
        if let Some(e) = &s.temp_error {
            let _ = writeln!(out, "  temperature: {e}");
        }
        let running = snap.guests.iter().filter(|g| g.status == "running").count();
        let _ = writeln!(out, "  guests: {running} running / {}", snap.guests.len());
        for g in &snap.guests {
            let key = |m: &str| format!("{}/guest/{}/{m}", s.id, g.vmid);
            let usage = if g.status == "running" {
                let spark = graphs
                    .and_then(|graphs| graphs.recent(&key("cpu")))
                    .map(|v| format!("  {}", sparkline(&v)))
                    .unwrap_or_default();
                format!(
                    "cpu {:>6}  ram {:>4}{spark}",
                    value(snap, &key("cpu")).map_or("--".to_owned(), |v| format!("{v:.1}%")),
                    pct(value(snap, &key("mem")))
                )
            } else {
                String::new()
            };
            let _ = writeln!(
                out,
                "    {:>6} {:<3} {:<20} {:<8} {:<10} {usage}",
                g.vmid,
                if g.kind == "lxc" { "CT" } else { "VM" },
                g.name,
                g.status,
                g.node
            );
        }
    }
    out
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

pub async fn run(
    config_path: &Path,
    only: Option<&str>,
    json: bool,
    watch: bool,
) -> Result<ExitCode, String> {
    let config = crate::load_config(config_path)?;
    let servers = crate::select(&config, only)?;
    if servers.is_empty() {
        return Err("no servers configured; add one with: pvectl setup NAME".to_owned());
    }
    let conn = Connection::session()
        .await
        .map_err(|e| format!("no session bus (needed for the GNOME Keyring): {e}"))?;
    if watch {
        return watch_loop(&conn, &servers).await;
    }
    let statuses = futures_util::future::join_all(servers.iter().map(|s| fetch(&conn, s))).await;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&to_json(&statuses)).unwrap_or_default()
        );
    } else {
        print!("{}", render_text(&statuses, None));
    }
    Ok(if statuses.iter().all(|s| s.result.is_ok()) {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

#[zbus::proxy(
    interface = "io.github.pauloeduardods.PveBar1",
    default_service = "io.github.pauloeduardods.PveBar1",
    default_path = "/io/github/pauloeduardods/PveBar1"
)]
trait PveBar {
    #[zbus(property)]
    fn api_version(&self) -> zbus::Result<u32>;

    fn get_history(&self, keys: &[&str]) -> zbus::Result<HashMap<String, (Vec<f64>, Vec<f64>)>>;
}

/// The keys `--watch` draws.
fn graph_keys(statuses: &[ServerStatus]) -> Vec<String> {
    let mut keys = Vec::new();
    for s in statuses {
        let Ok(snap) = &s.result else { continue };
        for n in &snap.nodes {
            for m in ["cpu", "mem", "temp"] {
                keys.push(format!("{}/node/{}/{m}", s.id, n.name));
            }
        }
        keys.extend(
            snap.guests
                .iter()
                .map(|g| format!("{}/guest/{}/cpu", s.id, g.vmid)),
        );
    }
    keys
}

/// When pved is already running (it is never started for this), its
/// history fills the graphs at once instead of after five minutes.
async fn history_from_pved(conn: &Connection, keys: &[String], history: &mut History, now: f64) {
    let Ok(dbus) = zbus::fdo::DBusProxy::new(conn).await else {
        return;
    };
    let Ok(name) = PveBarProxy::builder(conn).build().await else {
        return;
    };
    let running = dbus
        .name_has_owner(name.inner().destination().clone())
        .await
        .unwrap_or(false);
    if !running || name.api_version().await.unwrap_or(1) < 2 {
        return;
    }
    let keys: Vec<&str> = keys.iter().map(String::as_str).collect();
    let Ok(series) = name.get_history(&keys).await else {
        return;
    };
    for (key, (ages, values)) in series {
        let server = key.split('/').next().unwrap_or_default();
        let points: Vec<(f64, f64)> = ages.iter().map(|a| now - a).zip(values).collect();
        history.server(server).backfill(&key, &points, now);
    }
}

async fn watch_loop(
    conn: &Connection,
    servers: &[&pve_core::config::Server],
) -> Result<ExitCode, String> {
    let start = Instant::now();
    let mut history = History::default();
    let mut stdout = std::io::stdout();
    let mut first = true;
    loop {
        let statuses = futures_util::future::join_all(servers.iter().map(|s| fetch(conn, s))).await;
        let now = start.elapsed().as_secs_f64();
        for s in &statuses {
            history
                .server(&s.id)
                .record(now, s.result.as_ref().ok().map(|snap| &snap.values));
        }
        if first {
            history_from_pved(conn, &graph_keys(&statuses), &mut history, now).await;
            first = false;
        }
        let graphs = Graphs {
            history: &history,
            now,
        };
        let screen = format!(
            "\x1b[H\x1b[2J{}\nRefreshing every {} s, Ctrl+C to quit.\n",
            render_text(&statuses, Some(&graphs)),
            backoff::NORMAL.as_secs()
        );
        stdout
            .write_all(screen.as_bytes())
            .and_then(|()| stdout.flush())
            .map_err(|e| e.to_string())?;
        tokio::time::sleep(backoff::NORMAL).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pve_core::fake::FakeCluster;

    #[test]
    fn sparklines_scale_between_the_lowest_and_highest_value() {
        assert_eq!(sparkline(&[60.0, 70.0, 80.0]), "▁▅█");
        assert_eq!(sparkline(&[1.0, f64::NAN, 1.0]), "▅ ▅", "flat");
        assert_eq!(sparkline(&[f64::NAN, f64::NAN]), "  ");
        assert_eq!(sparkline(&[]), "");
    }

    fn statuses(cluster: &FakeCluster) -> Vec<ServerStatus> {
        vec![
            ServerStatus {
                id: "home".into(),
                result: Ok(Snapshot::build(
                    "home",
                    &cluster.resources(),
                    Some(&cluster.temp()),
                )),
                temp_error: None,
            },
            ServerStatus {
                id: "lab".into(),
                result: Err("cannot connect to Proxmox".into()),
                temp_error: None,
            },
        ]
    }

    #[test]
    fn watch_screen_has_graphs_under_nodes_and_on_running_guests() {
        let mut cluster = FakeCluster::new(42, "pve", 4);
        let mut history = History::default();
        // Fewer than 30 cycles: the fake starts or stops a guest every 30.
        for i in 0..29 {
            cluster.step();
            let s = statuses(&cluster);
            for s in &s {
                history.server(&s.id).record(
                    f64::from(i) * 10.0,
                    s.result.as_ref().ok().map(|x| &x.values),
                );
            }
        }
        let s = statuses(&cluster);
        let text = render_text(
            &s,
            Some(&Graphs {
                history: &history,
                now: 280.0,
            }),
        );
        let lines: Vec<&str> = text.lines().collect();
        assert!(lines[1].starts_with("  node pve"), "{text}");
        for (line, label) in lines[2..5].iter().zip(["cpu %", "ram %", "temp °C"]) {
            assert!(line.trim_start().starts_with(label), "{line}");
            let spark: String = line.chars().filter(|c| BLOCKS.contains(c)).collect();
            assert_eq!(spark.chars().count(), 29, "{line}");
        }
        let running = lines.iter().find(|l| l.contains("running  ")).unwrap();
        assert!(running.chars().any(|c| BLOCKS.contains(&c)), "{running}");
        let stopped = lines.iter().find(|l| l.contains("stopped")).unwrap();
        assert!(!stopped.chars().any(|c| BLOCKS.contains(&c)), "{stopped}");
        assert!(text.contains("lab: cannot connect"));
        assert!(
            !render_text(&s, None).contains('▁'),
            "plain status: no graphs"
        );
    }

    #[test]
    fn graph_keys_cover_nodes_and_guests() {
        let keys = graph_keys(&statuses(&FakeCluster::new(1, "pve", 2)));
        assert_eq!(
            keys,
            [
                "home/node/pve/cpu",
                "home/node/pve/mem",
                "home/node/pve/temp",
                "home/guest/100/cpu",
                "home/guest/101/cpu"
            ]
        );
    }
}
