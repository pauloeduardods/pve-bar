// SPDX-License-Identifier: GPL-3.0-or-later
//! The D-Bus object and the state behind it: what is published, the
//! history of every value and who watches which guest.

use std::borrow::Cow;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use pve_core::Snapshot;
use pve_core::diff::{self, Values};
use pve_core::history::{self, History};
use tokio::sync::Notify;
use zbus::fdo::Properties;
use zbus::interface;
use zbus::message::Header;
use zbus::names::InterfaceName;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::Value;

use crate::watch::{self, Watches};

pub const BUS_NAME: &str = "io.github.pauloeduardods.PveBar1";
pub const OBJECT_PATH: &str = "/io/github/pauloeduardods/PveBar1";
pub const IFACE: &str = "io.github.pauloeduardods.PveBar1";
/// 2 added GetHistory, Watch and Unwatch.
pub const API_VERSION: u32 = 2;

/// (server, state, message)
pub type ServerRow = (String, String, String);
/// (server, node, status)
pub type NodeRow = (String, String, String);
/// (server, vmid, kind, node, name, status)
pub type GuestRow = (String, u32, String, String, String, String);

/// Everything the object publishes.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Published {
    pub config_error: String,
    pub servers: Vec<ServerRow>,
    pub nodes: Vec<NodeRow>,
    pub guests: Vec<GuestRow>,
    pub values: Values,
}

/// What one publish changed.
#[derive(Debug, Default)]
pub struct Changes {
    pub properties: Vec<(&'static str, Value<'static>)>,
    pub values: Vec<(String, f64)>,
}

impl Changes {
    pub fn is_empty(&self) -> bool {
        self.properties.is_empty() && self.values.is_empty()
    }
}

/// One server's view for a publish: its state and, when it answered, its data.
pub struct ServerView<'a> {
    pub id: &'a str,
    pub state: &'a str,
    pub message: &'a str,
    pub snapshot: Option<&'a Snapshot>,
}

impl Published {
    /// Builds the next state from the servers (in config order).
    pub fn compose(config_error: &str, servers: &[ServerView<'_>]) -> Self {
        let mut p = Published {
            config_error: config_error.to_owned(),
            ..Published::default()
        };
        for s in servers {
            p.servers
                .push((s.id.to_owned(), s.state.to_owned(), s.message.to_owned()));
            let Some(snap) = s.snapshot else { continue };
            p.nodes.extend(
                snap.nodes
                    .iter()
                    .map(|n| (n.server.clone(), n.name.clone(), n.status.clone())),
            );
            p.guests.extend(snap.guests.iter().map(|g| {
                (
                    g.server.clone(),
                    g.vmid,
                    g.kind.clone(),
                    g.node.clone(),
                    g.name.clone(),
                    g.status.clone(),
                )
            }));
            p.values
                .extend(snap.values.iter().map(|(k, v)| (k.clone(), *v)));
        }
        p
    }

    /// Replaces self with `next` and reports what changed.
    pub fn replace(&mut self, next: Published) -> Changes {
        let mut c = Changes {
            values: diff::diff(&self.values, &next.values),
            ..Changes::default()
        };
        if self.config_error != next.config_error {
            c.properties
                .push(("ConfigError", Value::from(next.config_error.clone())));
        }
        if self.servers != next.servers {
            c.properties
                .push(("Servers", Value::from(next.servers.clone())));
        }
        if self.nodes != next.nodes {
            c.properties
                .push(("Nodes", Value::from(next.nodes.clone())));
        }
        if self.guests != next.guests {
            c.properties
                .push(("Guests", Value::from(next.guests.clone())));
        }
        *self = next;
        c
    }
}

/// Everything the object and the polling loop share. One thread, so the
/// lock is never contended; it only satisfies zbus.
#[derive(Debug, Default)]
pub struct State {
    pub published: Published,
    pub history: History,
    pub watches: Watches,
}

pub type Shared = Arc<Mutex<State>>;

pub fn lock(m: &Mutex<State>) -> MutexGuard<'_, State> {
    // A panic while holding the lock leaves plain data behind; keep serving.
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// pved's monotonic clock, in seconds: the history's time base.
#[derive(Debug, Clone, Copy)]
pub struct Clock(Instant);

impl Clock {
    pub fn start() -> Self {
        Self(Instant::now())
    }

    pub fn now(&self) -> f64 {
        self.0.elapsed().as_secs_f64()
    }
}

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "io.github.pauloeduardods.PveBar1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    /// A client watches the most guests it may ([`watch::MAX_PER_CALLER`]).
    TooManyWatches(String),
}

/// (ages in seconds, oldest first; values, NaN for gaps)
pub type HistoryReply = HashMap<String, history::Series>;

pub struct PveBar {
    pub shared: Shared,
    pub fake: bool,
    pub clock: Clock,
    /// Wakes the polling loop when the set of watched guests changed.
    pub watch_changed: Arc<Notify>,
}

/// The caller's unique bus name; "" on a peer-to-peer connection.
fn caller(header: &Header<'_>) -> String {
    header.sender().map(|s| s.to_string()).unwrap_or_default()
}

#[interface(name = "io.github.pauloeduardods.PveBar1")]
impl PveBar {
    #[zbus(property)]
    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }

    #[zbus(property)]
    fn api_version(&self) -> u32 {
        API_VERSION
    }

    #[zbus(property)]
    fn fake(&self) -> bool {
        self.fake
    }

    #[zbus(property)]
    fn config_error(&self) -> String {
        lock(&self.shared).published.config_error.clone()
    }

    #[zbus(property)]
    fn servers(&self) -> Vec<ServerRow> {
        lock(&self.shared).published.servers.clone()
    }

    #[zbus(property)]
    fn nodes(&self) -> Vec<NodeRow> {
        lock(&self.shared).published.nodes.clone()
    }

    #[zbus(property)]
    fn guests(&self) -> Vec<GuestRow> {
        lock(&self.shared).published.guests.clone()
    }

    fn get_values(&self) -> HashMap<String, f64> {
        lock(&self.shared)
            .published
            .values
            .iter()
            .map(|(k, v)| (k.clone(), *v))
            .collect()
    }

    /// The last hour of the given keys (every key when empty). Clients call
    /// it once per connection and then append what `Updated` brings.
    fn get_history(&self, keys: Vec<String>) -> HistoryReply {
        let now = self.clock.now();
        lock(&self.shared)
            .history
            .query(&keys, now)
            .into_iter()
            .collect()
    }

    /// Fetch this guest's details every poll, for as long as the caller
    /// watches it (or until its bus name goes away).
    fn watch(
        &self,
        #[zbus(header)] header: Header<'_>,
        server: String,
        vmid: u32,
    ) -> Result<(), Error> {
        let first = lock(&self.shared)
            .watches
            .watch(&caller(&header), (server, vmid))
            .map_err(|watch::TooMany| {
                Error::TooManyWatches(format!(
                    "a client can watch at most {} guests",
                    watch::MAX_PER_CALLER
                ))
            })?;
        if first {
            self.watch_changed.notify_one();
        }
        Ok(())
    }

    fn unwatch(&self, #[zbus(header)] header: Header<'_>, server: String, vmid: u32) {
        let last = lock(&self.shared)
            .watches
            .unwatch(&caller(&header), &(server, vmid));
        if last {
            self.watch_changed.notify_one();
        }
    }

    #[zbus(signal)]
    async fn updated(emitter: &SignalEmitter<'_>, values: HashMap<String, f64>)
    -> zbus::Result<()>;
}

/// Publishes `next` and emits one `PropertiesChanged` (if any property
/// changed) and one `Updated` (if any value changed).
pub async fn publish(
    shared: &Shared,
    emitter: &SignalEmitter<'_>,
    next: Published,
) -> zbus::Result<()> {
    let changes = lock(shared).published.replace(next);
    if changes.is_empty() {
        return Ok(());
    }
    if !changes.properties.is_empty() {
        let map: HashMap<&str, Value<'_>> = changes.properties.into_iter().collect();
        Properties::properties_changed(
            emitter,
            InterfaceName::from_static_str_unchecked(IFACE),
            map,
            Cow::Borrowed(&[]),
        )
        .await?;
    }
    if !changes.values.is_empty() {
        PveBar::updated(emitter, changes.values.into_iter().collect()).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use pve_core::fake::FakeCluster;

    fn snap(server: &str, guests: usize) -> Snapshot {
        let f = FakeCluster::new(3, "pve", guests);
        Snapshot::build(server, &f.resources(), Some(&f.temp()))
    }

    fn view<'a>(id: &'a str, state: &'a str, snapshot: Option<&'a Snapshot>) -> ServerView<'a> {
        ServerView {
            id,
            state,
            message: "",
            snapshot,
        }
    }

    #[test]
    fn compose_keeps_server_order_and_prefixes() {
        let (a, b) = (snap("home", 3), snap("lab", 2));
        let p = Published::compose(
            "",
            &[view("lab", "ok", Some(&b)), view("home", "ok", Some(&a))],
        );
        assert_eq!(p.servers[0].0, "lab");
        assert_eq!(p.nodes[0].0, "lab");
        assert_eq!(p.guests.len(), 5);
        assert_eq!(p.guests[0].0, "lab");
        assert!(p.values.contains_key("home/node/pve/cpu"));
        assert!(p.values.contains_key("lab/guest/100/cpu"));
    }

    #[test]
    fn a_failed_server_drops_only_its_own_data() {
        let (a, b) = (snap("home", 3), snap("lab", 2));
        let mut p = Published::compose(
            "",
            &[view("home", "ok", Some(&a)), view("lab", "ok", Some(&b))],
        );
        let next = Published::compose(
            "",
            &[view("home", "ok", Some(&a)), view("lab", "offline", None)],
        );
        let c = p.replace(next);
        let names: Vec<_> = c.properties.iter().map(|(n, _)| *n).collect();
        assert_eq!(names, ["Servers", "Nodes", "Guests"]);
        assert!(
            c.values
                .iter()
                .all(|(k, v)| k.starts_with("lab/") && v.is_nan())
        );
        assert!(p.values.keys().all(|k| k.starts_with("home/")));
    }

    #[test]
    fn nothing_changed_means_no_signal() {
        let a = snap("home", 3);
        let mut p = Published::compose("", &[view("home", "ok", Some(&a))]);
        let c = p.replace(Published::compose("", &[view("home", "ok", Some(&a))]));
        assert!(c.is_empty());
    }

    #[test]
    fn config_error_is_a_property() {
        let mut p = Published::default();
        let c = p.replace(Published::compose("line 3: bad", &[]));
        assert_eq!(c.properties.len(), 1);
        assert_eq!(c.properties[0].0, "ConfigError");
    }
}
