// SPDX-License-Identifier: GPL-3.0-or-later
//! pved --fake on a private session bus: the name, the properties, GetValues,
//! Updated, GetHistory and Watch/Unwatch, as the extension sees them. Needs dbus-daemon
//! (package dbus-daemon); never touches the real session bus.

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use futures_util::StreamExt as _;
use zbus::Connection;

const NAME: &str = "io.github.pauloeduardods.PveBar1";
const PATH: &str = "/io/github/pauloeduardods/PveBar1";

struct Bus {
    daemon: Child,
    address: String,
    pved: Option<Child>,
}

impl Drop for Bus {
    fn drop(&mut self) {
        if let Some(p) = &mut self.pved {
            let _ = p.kill();
            let _ = p.wait();
        }
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

fn private_bus() -> Bus {
    use std::io::{BufRead, BufReader};
    let mut daemon = Command::new("dbus-daemon")
        .args(["--session", "--nofork", "--print-address=1"])
        .stdout(Stdio::piped())
        .spawn()
        .expect("dbus-daemon (package dbus-daemon) is needed for these tests");
    let mut address = String::new();
    BufReader::new(daemon.stdout.take().unwrap())
        .read_line(&mut address)
        .unwrap();
    Bus {
        daemon,
        address: address.trim().to_owned(),
        pved: None,
    }
}

fn start_pved(bus: &mut Bus) {
    bus.pved = Some(
        Command::new(env!("CARGO_BIN_EXE_pved"))
            .args(["--fake", "--interval-ms", "100"])
            .env("DBUS_SESSION_BUS_ADDRESS", &bus.address)
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
}

async fn connect(address: &str) -> Connection {
    zbus::connection::Builder::address(address)
        .unwrap()
        .build()
        .await
        .unwrap()
}

async fn wait_for_name(conn: &Connection) {
    let dbus = zbus::fdo::DBusProxy::new(conn).await.unwrap();
    for _ in 0..100 {
        if dbus.name_has_owner(NAME.try_into().unwrap()).await.unwrap() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("pved never claimed {NAME}");
}

async fn proxy(conn: &Connection) -> zbus::Proxy<'static> {
    zbus::Proxy::new(conn, NAME, PATH, NAME).await.unwrap()
}

/// pved claims its name before its first poll (so D-Bus activation is quick),
/// and until that poll has published there is nothing to read yet.
async fn wait_for_first_poll(p: &zbus::Proxy<'_>) -> HashMap<String, f64> {
    for _ in 0..100 {
        let values: HashMap<String, f64> = p.call("GetValues", &()).await.unwrap();
        if !values.is_empty() {
            return values;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("pved published no values within 2 s");
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

#[test]
fn publishes_servers_nodes_guests_and_values() {
    let mut bus = private_bus();
    start_pved(&mut bus);
    rt().block_on(async {
        let conn = connect(&bus.address).await;
        wait_for_name(&conn).await;
        let p = proxy(&conn).await;
        let values = wait_for_first_poll(&p).await;

        let version: String = p.get_property("Version").await.unwrap();
        assert_eq!(version, env!("CARGO_PKG_VERSION"));
        assert_eq!(p.get_property::<u32>("ApiVersion").await.unwrap(), 2);
        assert!(p.get_property::<bool>("Fake").await.unwrap());
        assert_eq!(p.get_property::<String>("ConfigError").await.unwrap(), "");

        let servers: Vec<(String, String, String)> = p.get_property("Servers").await.unwrap();
        let ids: Vec<_> = servers.iter().map(|s| s.0.as_str()).collect();
        assert_eq!(ids, ["home", "lab"]);

        let nodes: Vec<(String, String, String)> = p.get_property("Nodes").await.unwrap();
        assert_eq!(nodes.len(), 2);
        let guests: Vec<(String, u32, String, String, String, String)> =
            p.get_property("Guests").await.unwrap();
        assert_eq!(guests.len(), 36);
        assert!(guests.iter().any(|g| g.0 == "lab" && g.1 == 100));
        assert!(guests.iter().any(|g| g.0 == "home" && g.1 == 100));

        assert!(values.contains_key("home/node/pve/cpu"));
        assert!(values.contains_key("home/node/pve/temp"));
        assert!(values.contains_key("lab/node/lab1/mem"));
        assert!(
            values
                .keys()
                .all(|k| k.starts_with("home/") || k.starts_with("lab/"))
        );
    });
}

#[test]
fn updated_carries_only_changes() {
    let mut bus = private_bus();
    start_pved(&mut bus);
    rt().block_on(async {
        let conn = connect(&bus.address).await;
        wait_for_name(&conn).await;
        let p = proxy(&conn).await;
        let all = wait_for_first_poll(&p).await;
        let mut updates = p.receive_signal("Updated").await.unwrap();
        let msg = tokio::time::timeout(Duration::from_secs(5), updates.next())
            .await
            .expect("no Updated signal within 5 s")
            .unwrap();
        let (changed,): (HashMap<String, f64>,) = msg.body().deserialize().unwrap();
        assert!(!changed.is_empty());
        assert!(
            changed.len() < all.len(),
            "only what changed, not everything"
        );
    });
}

type History = HashMap<String, (Vec<f64>, Vec<f64>)>;

async fn history(p: &zbus::Proxy<'_>, keys: &[&str]) -> History {
    p.call("GetHistory", &(keys,)).await.unwrap()
}

/// Calls GetValues until `check` holds (pved polls every 100 ms here).
async fn values_until(
    p: &zbus::Proxy<'_>,
    what: &str,
    check: impl Fn(&HashMap<String, f64>) -> bool,
) -> HashMap<String, f64> {
    for _ in 0..150 {
        let values: HashMap<String, f64> = p.call("GetValues", &()).await.unwrap();
        if check(&values) {
            return values;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("timed out waiting for {what}");
}

#[test]
fn history_of_every_key_oldest_first() {
    let mut bus = private_bus();
    start_pved(&mut bus);
    rt().block_on(async {
        let conn = connect(&bus.address).await;
        wait_for_name(&conn).await;
        let p = proxy(&conn).await;
        let values = wait_for_first_poll(&p).await;
        tokio::time::sleep(Duration::from_millis(500)).await;

        let all = history(&p, &[]).await;
        assert!(values.keys().all(|k| all.contains_key(k)), "every key");
        let (ages, cpu) = &all["home/node/pve/cpu"];
        assert!(ages.len() >= 3, "{ages:?}");
        assert_eq!(ages.len(), cpu.len());
        assert!(
            ages.windows(2).all(|w| w[0] > w[1]),
            "oldest first: {ages:?}"
        );
        assert!(cpu.iter().all(|v| (0.0..=100.0).contains(v)));

        let some = history(&p, &["lab/node/lab1/mem", "lab/guest/9999/cpu", "x"]).await;
        assert_eq!(some.keys().collect::<Vec<_>>(), ["lab/node/lab1/mem"]);
    });
}

#[test]
fn watch_brings_details_with_a_backfilled_hour_and_unwatch_removes_them() {
    let mut bus = private_bus();
    start_pved(&mut bus);
    rt().block_on(async {
        let conn = connect(&bus.address).await;
        wait_for_name(&conn).await;
        let p = proxy(&conn).await;
        wait_for_first_poll(&p).await;
        assert!(
            history(&p, &["home/guest/100/netin"]).await.is_empty(),
            "no details before a watch"
        );

        let _: () = p.call("Watch", &("home", 100u32)).await.unwrap();
        let values = values_until(&p, "the guest's rates", |v| {
            v.contains_key("home/guest/100/netin")
        })
        .await;
        for key in [
            "uptime",
            "netout",
            "diskread",
            "diskwrite",
            "maxmem",
            "maxcpu",
            "fs",
        ] {
            assert!(
                values.contains_key(&format!("home/guest/100/{key}")),
                "{key}: {values:?}"
            );
        }
        let h = history(&p, &["home/guest/100/netin", "home/guest/100/cpu"]).await;
        let (ages, netin) = &h["home/guest/100/netin"];
        assert!(netin.len() >= 60, "the hour from rrddata: {}", netin.len());
        assert!(ages[0] > 3000.0 && ages[0] <= 3600.0, "{}", ages[0]);
        assert!(h["home/guest/100/cpu"].0[0] > 3000.0, "cpu backfilled too");

        let mut updates = p.receive_signal("Updated").await.unwrap();
        let _: () = p.call("Unwatch", &("home", 100u32)).await.unwrap();
        let removed = tokio::time::timeout(Duration::from_secs(5), async {
            while let Some(msg) = updates.next().await {
                let (changed,): (HashMap<String, f64>,) = msg.body().deserialize().unwrap();
                if let Some(v) = changed.get("home/guest/100/uptime") {
                    return *v;
                }
            }
            panic!("signal stream ended");
        })
        .await
        .expect("no NaN for the unwatched guest");
        assert!(removed.is_nan());
        let values: HashMap<String, f64> = p.call("GetValues", &()).await.unwrap();
        assert!(!values.contains_key("home/guest/100/netin"));
        assert!(values.contains_key("home/guest/100/cpu"));
    });
}

#[test]
fn a_client_that_leaves_stops_watching_and_watches_are_limited() {
    let mut bus = private_bus();
    start_pved(&mut bus);
    rt().block_on(async {
        let conn = connect(&bus.address).await;
        wait_for_name(&conn).await;
        let p = proxy(&conn).await;
        wait_for_first_poll(&p).await;

        {
            let other = connect(&bus.address).await;
            let q = proxy(&other).await;
            for vmid in 100..116u32 {
                let _: () = q.call("Watch", &("lab", vmid)).await.unwrap();
            }
            let err = q
                .call::<_, _, ()>("Watch", &("lab", 116u32))
                .await
                .unwrap_err();
            match err {
                zbus::Error::MethodError(name, _, _) => assert_eq!(
                    name.as_str(),
                    "io.github.pauloeduardods.PveBar1.Error.TooManyWatches"
                ),
                e => panic!("{e:?}"),
            }
            // Watching one again does not count, and others still can.
            let _: () = q.call("Watch", &("lab", 100u32)).await.unwrap();
            let _: () = p.call("Watch", &("lab", 116u32)).await.unwrap();
            values_until(&p, "lab details", |v| {
                v.contains_key("lab/guest/101/uptime")
            })
            .await;
        }
        values_until(&p, "details gone with their client", |v| {
            !v.contains_key("lab/guest/101/uptime")
        })
        .await;
    });
}
