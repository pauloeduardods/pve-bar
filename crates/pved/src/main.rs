// SPDX-License-Identifier: GPL-3.0-or-later
//! pved: polls one or more Proxmox VE servers and publishes them on the
//! session bus for the pve-bar GNOME extension. Read-only, no root.

mod poller;
mod service;
mod watch;

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt as _;
use futures_util::future::join_all;
use pve_core::backoff::{self, Schedule};
use pve_core::fake::FakeCluster;
use pve_sys::paths;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::Notify;
use zbus::Connection;
use zbus::object_server::SignalEmitter;

use crate::poller::{Now, Poller, Source};
use crate::service::{BUS_NAME, Clock, OBJECT_PATH, Published, PveBar, ServerView, Shared, lock};

const USAGE: &str = "\
Usage: pved [--fake] [--config PATH]

The pve-bar user service. It is started by D-Bus activation through
systemd --user (pved.service) and needs no options in normal use.

  --fake         publish two synthetic servers (home: 30 guests, lab: 6)
                 instead of talking to Proxmox
  --config PATH  read PATH instead of ~/.config/pve-bar/pved.conf

Reload the configuration with: systemctl --user reload pved";

#[derive(Debug, PartialEq, Eq)]
struct Options {
    fake: bool,
    config: Option<PathBuf>,
    // Test hook: a shorter polling interval.
    interval: Duration,
}

enum Parsed {
    Run(Options),
    Print(String),
}

fn parse_args(args: impl IntoIterator<Item = String>) -> Result<Parsed, String> {
    let mut options = Options {
        fake: false,
        config: None,
        interval: backoff::NORMAL,
    };
    let mut args = args.into_iter();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or(format!("{name} needs a value"));
        match arg.as_str() {
            "--fake" => options.fake = true,
            "--config" => options.config = Some(value("--config")?.into()),
            "--interval-ms" => {
                let ms: u64 = value("--interval-ms")?
                    .parse()
                    .map_err(|_| "--interval-ms needs a number".to_owned())?;
                options.interval = Duration::from_millis(ms.max(50));
            }
            "-h" | "--help" => return Ok(Parsed::Print(format!("{USAGE}\n"))),
            "-V" | "--version" => {
                return Ok(Parsed::Print(format!(
                    "pved {}\n",
                    env!("CARGO_PKG_VERSION")
                )));
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(Parsed::Run(options))
}

/// The pollers for the current configuration, and the config error if any.
fn load_pollers(options: &Options) -> (Vec<Poller>, String) {
    let schedule = Schedule::new(options.interval);
    if options.fake {
        let fake = |id: &str, seed, node: &str, guests| {
            Poller::new(
                id.to_owned(),
                Source::Fake(FakeCluster::new(seed, node, guests)),
                schedule.clone(),
            )
        };
        return (
            vec![fake("home", 42, "pve", 30), fake("lab", 7, "lab1", 6)],
            String::new(),
        );
    }
    let path = options.config.clone().unwrap_or_else(paths::config_path);
    match paths::load(&path) {
        Ok(Some(config)) => {
            let pollers: Vec<_> = config
                .servers
                .into_iter()
                .map(|s| Poller::real(s, schedule.clone()))
                .collect();
            eprintln!(
                "config {}: {} server(s): {}",
                path.display(),
                pollers.len(),
                pollers
                    .iter()
                    .map(|p| p.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
            (pollers, String::new())
        }
        Ok(None) => {
            eprintln!("no {} yet; run: pvectl setup NAME", path.display());
            (Vec::new(), String::new())
        }
        Err(e) => {
            eprintln!("{e}");
            (Vec::new(), e)
        }
    }
}

fn compose(pollers: &[Poller], config_error: &str) -> Published {
    let views: Vec<_> = pollers
        .iter()
        .map(|p| ServerView {
            id: &p.id,
            state: p.state,
            message: &p.message,
            snapshot: p.snapshot.as_ref(),
        })
        .collect();
    Published::compose(config_error, &views)
}

#[zbus::proxy(
    interface = "org.gnome.ScreenSaver",
    default_service = "org.gnome.ScreenSaver",
    default_path = "/org/gnome/ScreenSaver"
)]
trait ScreenSaver {
    fn get_active(&self) -> zbus::Result<bool>;

    #[zbus(signal)]
    fn active_changed(&self, active: bool) -> zbus::Result<()>;
}

fn unix_now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |d| d.as_secs_f64())
}

/// Hands each poller the guests watched on its server; true for the ones
/// with a watch that has not been fetched yet.
fn sync_watches(shared: &Shared, pollers: &mut [Poller]) -> Vec<bool> {
    let state = lock(shared);
    pollers
        .iter_mut()
        .map(|p| p.sync_watches(&state.watches.of_server(&p.id)))
        .collect()
}

/// Records one sample per key of every server just polled, and the
/// backfill the pollers brought back.
fn record_history(shared: &Shared, pollers: &mut [Poller], polled: &[bool], now: f64) {
    let mut state = lock(shared);
    for (p, polled) in pollers.iter_mut().zip(polled) {
        let history = state.history.server(&p.id);
        if *polled {
            history.record(now, p.snapshot.as_ref().map(|s| &s.values));
        }
        for (key, points) in p.backfill.drain(..) {
            history.backfill(&key, &points, now);
        }
    }
}

async fn run(options: Options) -> zbus::Result<()> {
    let conn = Connection::session().await?;
    let clock = Clock::start();
    let (mut pollers, mut config_error) = load_pollers(&options);
    let shared = Shared::default();
    lock(&shared).published = compose(&pollers, &config_error);
    let watch_changed = Arc::new(Notify::new());

    conn.object_server()
        .at(
            OBJECT_PATH,
            PveBar {
                shared: Arc::clone(&shared),
                fake: options.fake,
                clock,
                watch_changed: Arc::clone(&watch_changed),
            },
        )
        .await?;
    // Only claim the name once the object is in place.
    conn.request_name(BUS_NAME).await?;
    eprintln!("pved {}: serving {BUS_NAME}", env!("CARGO_PKG_VERSION"));
    let emitter = SignalEmitter::new(&conn, OBJECT_PATH)?;

    // A client that leaves the bus (or crashes) stops watching. The match
    // rule asks only for names that lost their owner (arg2 = ""), so a
    // client connecting does not wake pved.
    let mut names_lost = match zbus::fdo::DBusProxy::new(&conn).await {
        Ok(dbus) => dbus
            .receive_name_owner_changed_with_args(&[(2, "")])
            .await
            .ok(),
        Err(_) => None,
    };

    // Screen lock: poll every 60 s while nobody can see the panel. Without
    // gnome-screensaver on the bus, the screen simply never counts as locked.
    let (mut locked, mut lock_changes) = match ScreenSaverProxy::new(&conn).await {
        Ok(proxy) => {
            let active = proxy.get_active().await.unwrap_or(false);
            (active, proxy.receive_active_changed().await.ok())
        }
        Err(_) => (false, None),
    };
    let mut hangup =
        signal(SignalKind::hangup()).map_err(|e| zbus::Error::Failure(e.to_string()))?;

    loop {
        let fresh = sync_watches(&shared, &mut pollers);
        let instant = Instant::now();
        let now = Now {
            mono: clock.now(),
            wall: unix_now(),
        };
        let conn = &conn;
        let polled = join_all(pollers.iter_mut().zip(fresh).map(|(p, fresh)| async move {
            if p.next <= instant {
                p.poll(conn, locked, now).await;
                true
            } else {
                if fresh {
                    p.start_watches(now).await;
                }
                false
            }
        }))
        .await;
        record_history(&shared, &mut pollers, &polled, now.mono);
        service::publish(&shared, &emitter, compose(&pollers, &config_error)).await?;

        // Unconfigured: wait for a reload, re-checking the file once a minute.
        let wake = pollers
            .iter()
            .map(|p| p.next)
            .min()
            .unwrap_or_else(|| Instant::now() + backoff::LOCKED);
        tokio::select! {
            () = tokio::time::sleep_until(wake.into()) => {
                if pollers.is_empty() && !options.fake {
                    (pollers, config_error) = load_pollers(&options);
                }
            }
            // Watch or Unwatch changed the watched guests: fetch or drop now.
            () = watch_changed.notified() => {}
            lost = async {
                match names_lost.as_mut() {
                    Some(stream) => stream.next().await,
                    None => std::future::pending().await,
                }
            } => {
                match lost {
                    Some(signal) => {
                        if let Ok(args) = signal.args() {
                            lock(&shared).watches.drop_caller(args.name.as_str());
                        }
                    }
                    None => names_lost = None,
                }
            }
            change = async {
                match lock_changes.as_mut() {
                    Some(stream) => stream.next().await,
                    None => std::future::pending().await,
                }
            } => {
                match change.and_then(|c| c.args().ok().map(|a| a.active)) {
                    Some(active) => {
                        let unlocked = locked && !active;
                        locked = active;
                        if unlocked {
                            // Back at the desk: fresh numbers now, not in a minute.
                            for p in &mut pollers {
                                p.next = Instant::now();
                            }
                        }
                    }
                    None => lock_changes = None,
                }
            }
            _ = hangup.recv() => {
                eprintln!("reloading the configuration");
                (pollers, config_error) = load_pollers(&options);
                lock(&shared)
                    .history
                    .retain_servers(|id| pollers.iter().any(|p| p.id == id));
            }
        }
    }
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(Parsed::Run(options)) => options,
        Ok(Parsed::Print(text)) => {
            print!("{text}");
            return ExitCode::SUCCESS;
        }
        Err(message) => {
            eprintln!("pved: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("pved: cannot start the runtime: {e}");
            return ExitCode::FAILURE;
        }
    };
    match runtime.block_on(run(options)) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("pved: {e}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Parsed, String> {
        parse_args(args.iter().map(|s| (*s).to_owned()))
    }

    #[test]
    fn defaults_are_production_values() {
        let Ok(Parsed::Run(o)) = parse(&[]) else {
            panic!()
        };
        assert_eq!(
            o,
            Options {
                fake: false,
                config: None,
                interval: Duration::from_secs(10),
            }
        );
    }

    #[test]
    fn options_and_test_hooks() {
        let Ok(Parsed::Run(o)) = parse(&["--fake", "--config", "/tmp/x", "--interval-ms", "10"])
        else {
            panic!()
        };
        assert!(o.fake);
        assert_eq!(o.config, Some(PathBuf::from("/tmp/x")));
        assert_eq!(o.interval, Duration::from_millis(50), "clamped");
    }

    #[test]
    fn bad_arguments() {
        assert!(parse(&["--config"]).is_err());
        assert!(parse(&["--interval-ms", "x"]).is_err());
        assert!(parse(&["--frobnicate"]).is_err());
    }

    #[test]
    fn fake_mode_has_two_servers() {
        let Ok(Parsed::Run(o)) = parse(&["--fake"]) else {
            panic!()
        };
        let (pollers, error) = load_pollers(&o);
        assert!(error.is_empty());
        let ids: Vec<_> = pollers.iter().map(|p| p.id.as_str()).collect();
        assert_eq!(ids, ["home", "lab"]);
    }

    #[test]
    fn missing_config_is_unconfigured_and_bad_config_is_an_error() {
        let dir = std::env::temp_dir().join(format!("pved-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("pved.conf");
        let o = Options {
            fake: false,
            config: Some(path.clone()),
            interval: backoff::NORMAL,
        };
        let (pollers, error) = load_pollers(&o);
        assert!(pollers.is_empty() && error.is_empty());
        std::fs::write(&path, "url = nope").unwrap();
        let (pollers, error) = load_pollers(&o);
        assert!(pollers.is_empty());
        assert!(error.contains("before any"), "{error}");
        std::fs::write(&path, "[a]\nurl = https://h:8006\ntoken_id = a@pve!b\n").unwrap();
        assert_eq!(load_pollers(&o).0.len(), 1);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
