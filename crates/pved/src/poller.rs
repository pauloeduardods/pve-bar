// SPDX-License-Identifier: GPL-3.0-or-later
//! One Proxmox server, polled on its own schedule: its HTTP clients (created
//! lazily from the keyring), its backoff, its last good snapshot and the
//! details of the guests clients watch.

use std::collections::{BTreeMap, BTreeSet};
use std::time::Instant;

use futures_util::StreamExt as _;
use pve_core::Snapshot;
use pve_core::backoff::Schedule;
use pve_core::config::Server;
use pve_core::diff::Values;
use pve_core::fake::FakeCluster;
use pve_core::guest::{self, Counters, GuestStatus, RrdPoint};
use pve_sys::secret::{self, Key};
use pve_sys::{FetchError, ProxmoxClient, TempClient};
use zbus::Connection;

/// `get-fsinfo` every 6th poll: one minute at 10 s. Disks fill slowly and
/// the agent call is the most expensive one of a guest.
const FS_EVERY: u32 = 6;

/// Detail requests in flight at once per server, on top of the main poll.
/// The HTTP client keeps this many + 1 connections alive, so a steady poll
/// does no new TLS handshakes.
const DETAIL_CONCURRENCY: usize = 3;

// One per server, a handful at most: boxing the big variant buys nothing.
#[allow(clippy::large_enum_variant)]
pub enum Source {
    Real {
        server: Server,
        client: Option<ProxmoxClient>,
        temp: Option<TempClient>,
        temp_error: String,
    },
    Fake(FakeCluster),
}

/// What pved knows about one watched guest between polls.
#[derive(Debug, Default)]
struct Detail {
    /// Counters of the last `status/current`, for the rates.
    counters: Option<Counters>,
    /// The guest's detail values, merged into the snapshot each poll.
    values: Values,
    /// Last `get-fsinfo` result; kept between the fetches.
    fs: Option<f64>,
    /// Detail fetches so far; 0 means the watch has just started.
    fetches: u32,
}

/// One guest's detail replies. `None` for what was not asked or failed.
#[derive(Debug, Default)]
struct DetailReply {
    status: Option<GuestStatus>,
    /// Asked (Some), and then the result: Some(None) when the agent did not
    /// answer, which makes the key go away.
    fs: Option<Option<f64>>,
    rrd: Option<Vec<RrdPoint>>,
}

/// Where a guest lives, from the last `/cluster/resources`.
struct Location {
    vmid: u32,
    node: String,
    kind: String,
    fs_due: bool,
    rrd_due: bool,
}

pub struct Poller {
    pub id: String,
    pub source: Source,
    pub schedule: Schedule,
    pub next: Instant,
    pub state: &'static str,
    pub message: String,
    pub snapshot: Option<Snapshot>,
    details: BTreeMap<u32, Detail>,
    /// rrddata points for the history, `(key, [(time, value)])` on pved's
    /// clock; the main loop moves them into the history.
    pub backfill: Vec<(String, Vec<(f64, f64)>)>,
}

/// (state, message) for the `Servers` property.
fn failure(e: &FetchError) -> &'static str {
    match e {
        FetchError::Offline(_) | FetchError::Protocol(_) => "offline",
        FetchError::Unauthorized(_) => "unauthorized",
        FetchError::Tls(_) => "tls-error",
    }
}

/// The clocks a poll needs: pved's monotonic seconds (history, rates) and
/// Unix time (to place rrddata points).
#[derive(Debug, Clone, Copy)]
pub struct Now {
    pub mono: f64,
    pub wall: f64,
}

impl Poller {
    pub fn new(id: String, source: Source, schedule: Schedule) -> Self {
        Self {
            id,
            source,
            schedule,
            next: Instant::now(),
            state: "connecting",
            message: String::new(),
            snapshot: None,
            details: BTreeMap::new(),
            backfill: Vec::new(),
        }
    }

    pub fn real(server: Server, schedule: Schedule) -> Self {
        Self::new(
            server.id.clone(),
            Source::Real {
                server,
                client: None,
                temp: None,
                temp_error: String::new(),
            },
            schedule,
        )
    }

    /// Follows the set of watched guests. A guest no longer watched loses
    /// its detail keys at once (they are published as NaN); a new one waits
    /// for [`Poller::start_watches`] or the next poll. True when a new guest
    /// is waiting for its first fetch.
    pub fn sync_watches(&mut self, watched: &BTreeSet<u32>) -> bool {
        let gone: Vec<u32> = self
            .details
            .keys()
            .filter(|v| !watched.contains(v))
            .copied()
            .collect();
        for vmid in gone {
            if let (Some(d), Some(snap)) = (self.details.remove(&vmid), self.snapshot.as_mut()) {
                for key in d.values.keys() {
                    snap.values.remove(key);
                }
            }
        }
        for vmid in watched {
            self.details.entry(*vmid).or_default();
        }
        self.details.values().any(|d| d.fetches == 0)
    }

    /// Fetches the details of newly watched guests now, rather than at the
    /// next poll, so a menu that just opened fills in at once.
    pub async fn start_watches(&mut self, now: Now) {
        if self.snapshot.is_none() {
            return;
        }
        let todo = self.locations(true);
        if todo.is_empty() {
            return;
        }
        let replies = self.fetch_details(todo, now).await;
        self.apply_details(replies, now);
        if let Some(snap) = self.snapshot.as_mut() {
            merge(&self.details, snap);
        }
    }

    /// One poll. Updates state, snapshot and schedule; never fails.
    pub async fn poll(&mut self, conn: &Connection, locked: bool, now: Now) {
        // Watched guests are found in the previous snapshot, so their
        // requests go out together with /cluster/resources.
        let todo = self.locations(false);
        let Source::Real {
            server,
            client,
            temp,
            temp_error,
        } = &mut self.source
        else {
            self.poll_fake(locked, now);
            return;
        };
        let connected = match client {
            Some(_) => Ok(()),
            None => connect(conn, server, client, temp).await,
        };
        let (result, replies) = match (connected, client.as_ref()) {
            (Err(e), _) => (Err(e), Vec::new()),
            (Ok(()), None) => (Err(("offline", String::new())), Vec::new()),
            (Ok(()), Some(api)) => {
                let (result, replies) = tokio::join!(
                    poll_real(&server.id, api, temp.as_ref(), temp_error),
                    fetch_all(api, todo)
                );
                if matches!(result, Err(("unauthorized", _))) {
                    // Read the token again next time: it may have been replaced.
                    *client = None;
                }
                (result, replies)
            }
        };
        self.finish(result, replies, locked, now);
    }

    /// The `--fake` poll: synthetic, synchronous, never fails.
    fn poll_fake(&mut self, locked: bool, now: Now) {
        let todo = self.locations(false);
        let Source::Fake(cluster) = &mut self.source else {
            return;
        };
        cluster.step();
        let cluster = &*cluster;
        let snap = Snapshot::build(&self.id, &cluster.resources(), Some(&cluster.temp()));
        let replies = todo.iter().map(|l| fake_detail(cluster, l, now)).collect();
        self.finish(Ok(snap), replies, locked, now);
    }

    fn finish(
        &mut self,
        result: Result<Snapshot, (&'static str, String)>,
        replies: Vec<(u32, DetailReply)>,
        locked: bool,
        now: Now,
    ) {
        let (state, message) = match result {
            Ok(mut snapshot) => {
                self.apply_details(replies, now);
                merge(&self.details, &mut snapshot);
                self.snapshot = Some(snapshot);
                self.schedule.success();
                ("ok", String::new())
            }
            Err((state, message)) => {
                self.snapshot = None;
                self.schedule.failure();
                (state, message)
            }
        };
        if state != self.state || message != self.message {
            if message.is_empty() {
                eprintln!("[{}] {state}", self.id);
            } else {
                eprintln!("[{}] {state}: {message}", self.id);
            }
        }
        self.state = state;
        self.message = message;
        self.next = Instant::now() + self.schedule.delay(locked);
    }

    /// Watched guests that exist in the last snapshot (all, or only the
    /// ones not fetched yet), and what is due for each.
    fn locations(&self, only_new: bool) -> Vec<Location> {
        let Some(snap) = &self.snapshot else {
            return Vec::new();
        };
        snap.guests
            .iter()
            .filter_map(|g| {
                let d = self.details.get(&g.vmid)?;
                if only_new && d.fetches > 0 {
                    return None;
                }
                Some(Location {
                    vmid: g.vmid,
                    node: g.node.clone(),
                    kind: g.kind.clone(),
                    fs_due: g.kind == "qemu" && d.fetches.is_multiple_of(FS_EVERY),
                    rrd_due: d.fetches == 0,
                })
            })
            .collect()
    }

    async fn fetch_details(&mut self, todo: Vec<Location>, now: Now) -> Vec<(u32, DetailReply)> {
        match &self.source {
            Source::Fake(cluster) => todo.iter().map(|l| fake_detail(cluster, l, now)).collect(),
            Source::Real {
                client: Some(api), ..
            } => fetch_all(api, todo).await,
            Source::Real { client: None, .. } => Vec::new(),
        }
    }

    fn apply_details(&mut self, replies: Vec<(u32, DetailReply)>, now: Now) {
        for (vmid, reply) in replies {
            let Some(d) = self.details.get_mut(&vmid) else {
                continue;
            };
            d.fetches = d.fetches.saturating_add(1);
            let prefix = format!("{}/guest/{vmid}/", self.id);
            if let Some(points) = reply.rrd {
                // Unix time to pved's clock; a server clock a little ahead
                // must not put points in the future.
                for (suffix, series) in guest::rrd_series(&points) {
                    let points = series
                        .into_iter()
                        .map(|(t, v)| (now.mono - (now.wall - t).max(0.0), v))
                        .collect();
                    self.backfill.push((format!("{prefix}{suffix}"), points));
                }
            }
            if let Some(fs) = reply.fs {
                d.fs = fs;
            }
            match reply.status {
                Some(status) => {
                    let counters = Counters::of(&status, now.mono);
                    d.values =
                        guest::detail_values(&prefix, &status, &counters, d.counters.as_ref());
                    d.counters = Some(counters);
                    if !status.agent_usable() {
                        d.fs = None;
                    }
                }
                // A failed request: nothing stale, and no rate across the gap.
                None => {
                    d.values.clear();
                    d.counters = None;
                    d.fs = None;
                }
            }
            match d.fs {
                Some(fs) => d.values.insert(format!("{prefix}fs"), fs),
                None => d.values.remove(&format!("{prefix}fs")),
            };
        }
    }
}

/// Adds the watched guests' detail values to a snapshot, for guests it has.
fn merge(details: &BTreeMap<u32, Detail>, snap: &mut Snapshot) {
    for g in &snap.guests {
        if let Some(d) = details.get(&g.vmid) {
            snap.values
                .extend(d.values.iter().map(|(k, v)| (k.clone(), *v)));
        }
    }
}

fn fake_detail(cluster: &FakeCluster, l: &Location, now: Now) -> (u32, DetailReply) {
    let status = cluster.guest_status(l.vmid, now.mono);
    let fs = (l.fs_due && status.as_ref().is_some_and(GuestStatus::agent_usable))
        .then(|| cluster.guest_fs(l.vmid));
    let reply = DetailReply {
        status,
        fs,
        rrd: l
            .rrd_due
            .then(|| cluster.guest_rrd(l.vmid, now.wall, now.mono)),
    };
    (l.vmid, reply)
}

/// The details of every guest in `todo`, a few requests at a time.
async fn fetch_all(api: &ProxmoxClient, todo: Vec<Location>) -> Vec<(u32, DetailReply)> {
    futures_util::stream::iter(todo)
        .map(|l| async move {
            let reply = fetch_detail(api, &l).await;
            (l.vmid, reply)
        })
        .buffer_unordered(DETAIL_CONCURRENCY)
        .collect()
        .await
}

/// One guest: `status/current`, then (when due and possible) the agent's
/// filesystems; the rrd hour alongside on the first fetch. Read-only GETs.
async fn fetch_detail(api: &ProxmoxClient, l: &Location) -> DetailReply {
    let base = format!("/nodes/{}/{}/{}", l.node, l.kind, l.vmid);
    let status = async {
        let status = api
            .get(&format!("{base}/status/current"))
            .await
            .ok()
            .and_then(|body| guest::parse_status(&body).ok());
        let fs = match &status {
            Some(s) if l.fs_due && s.agent_usable() => Some(
                api.get(&format!("{base}/agent/get-fsinfo"))
                    .await
                    .ok()
                    .and_then(|body| guest::parse_fsinfo(&body).ok().flatten()),
            ),
            _ => None,
        };
        (status, fs)
    };
    let rrd = async {
        if !l.rrd_due {
            return None;
        }
        api.get(&format!("{base}/rrddata?timeframe=hour&cf=AVERAGE"))
            .await
            .ok()
            .and_then(|body| guest::parse_rrd(&body).ok())
    };
    let ((status, fs), rrd) = tokio::join!(status, rrd);
    DetailReply { status, fs, rrd }
}

/// Creates the HTTP clients from the keyring tokens.
async fn connect(
    conn: &Connection,
    server: &Server,
    client: &mut Option<ProxmoxClient>,
    temp: &mut Option<TempClient>,
) -> Result<(), (&'static str, String)> {
    let key = Key::ApiToken { server: &server.id };
    let token = match secret::lookup(conn, &key, false).await {
        Ok(Some(t)) => t,
        Ok(None) => {
            return Err((
                "no-token",
                format!(
                    "no API token in the GNOME Keyring; run: pvectl setup {}",
                    server.id
                ),
            ));
        }
        Err(e) => return Err(("no-token", e)),
    };
    *client = Some(ProxmoxClient::new(server, &token).map_err(|e| ("offline", e))?);
    *temp = None;
    if !server.temp_url.is_empty() {
        let key = Key::TempAgent { server: &server.id };
        match secret::lookup(conn, &key, false).await {
            Ok(Some(t)) => match TempClient::new(&server.temp_url, &t) {
                Ok(c) => *temp = Some(c),
                Err(e) => eprintln!("[{}] temperature agent: {e}", server.id),
            },
            Ok(None) => eprintln!(
                "[{}] temperature agent: no token in the GNOME Keyring; run: pvectl setup {}",
                server.id, server.id
            ),
            Err(e) => eprintln!("[{}] temperature agent: {e}", server.id),
        }
    }
    Ok(())
}

async fn poll_real(
    id: &str,
    api: &ProxmoxClient,
    temp: Option<&TempClient>,
    temp_error: &mut String,
) -> Result<Snapshot, (&'static str, String)> {
    let (resources, report) = tokio::join!(api.resources(), async {
        match temp {
            Some(t) => Some(t.report().await),
            None => None,
        }
    });
    let resources = resources.map_err(|e| (failure(&e), e.message().to_owned()))?;
    let host_temp = match report {
        Some(Ok(r)) => {
            if !temp_error.is_empty() {
                eprintln!("[{id}] temperature agent: ok");
                temp_error.clear();
            }
            r.host_temp()
        }
        Some(Err(e)) => {
            let text = e.message().to_owned();
            if *temp_error != text {
                eprintln!("[{id}] temperature agent: {text}");
                *temp_error = text;
            }
            None
        }
        None => None,
    };
    Ok(Snapshot::build(id, &resources, host_temp.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pve_core::backoff;

    fn fake() -> Poller {
        Poller::new(
            "home".into(),
            Source::Fake(FakeCluster::new(42, "pve", 30)),
            Schedule::new(backoff::NORMAL),
        )
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    fn poll(p: &mut Poller, t: f64) {
        p.poll_fake(
            false,
            Now {
                mono: t,
                wall: 1_729_000_000.0 + t,
            },
        );
    }

    fn keys(p: &Poller, vmid: u32) -> Vec<String> {
        let prefix = format!("home/guest/{vmid}/");
        let snap = p.snapshot.as_ref().unwrap();
        snap.values
            .keys()
            .filter(|k| k.starts_with(&prefix))
            .map(|k| k[prefix.len()..].to_owned())
            .collect()
    }

    #[test]
    fn a_watch_brings_details_and_backfill_then_rates() {
        rt().block_on(async {
            let mut p = fake();
            poll(&mut p, 0.0);
            assert_eq!(keys(&p, 100), ["cpu", "mem"]);

            assert!(p.sync_watches(&BTreeSet::from([100])));
            let now = Now {
                mono: 5.0,
                wall: 1_729_000_005.0,
            };
            p.start_watches(now).await;
            assert_eq!(
                keys(&p, 100),
                ["cpu", "fs", "maxcpu", "maxmem", "mem", "uptime"]
            );
            let backfilled: Vec<_> = p.backfill.iter().map(|(k, _)| k.as_str()).collect();
            assert_eq!(
                backfilled,
                [
                    "home/guest/100/cpu",
                    "home/guest/100/mem",
                    "home/guest/100/netin",
                    "home/guest/100/netout"
                ]
            );
            let (_, points) = &p.backfill[0];
            assert_eq!(points.len(), 70);
            assert!(points.iter().all(|(t, _)| *t <= 5.0 && *t > 5.0 - 4200.0));
            assert!(!p.sync_watches(&BTreeSet::from([100])), "nothing new");

            poll(&mut p, 10.0);
            let v = &p.snapshot.as_ref().unwrap().values;
            assert!(v["home/guest/100/netin"] > 0.0);
            assert!(v.contains_key("home/guest/100/diskwrite"));
            assert!(v.contains_key("home/guest/100/fs"), "kept between fetches");
        });
    }

    #[test]
    fn unwatching_removes_the_keys_at_once() {
        let mut p = fake();
        poll(&mut p, 0.0);
        p.sync_watches(&BTreeSet::from([101]));
        poll(&mut p, 10.0);
        assert!(keys(&p, 101).contains(&"uptime".to_owned()));
        assert!(
            !keys(&p, 101).contains(&"fs".to_owned()),
            "a container has no agent"
        );
        p.sync_watches(&BTreeSet::new());
        assert_eq!(keys(&p, 101), ["cpu", "mem"]);
        poll(&mut p, 20.0);
        assert_eq!(keys(&p, 101), ["cpu", "mem"]);
    }

    #[test]
    fn fs_is_fetched_every_sixth_time() {
        let mut p = fake();
        poll(&mut p, 0.0);
        p.sync_watches(&BTreeSet::from([100, 101]));
        let due = |p: &Poller| -> Vec<(u32, bool, bool)> {
            p.locations(false)
                .iter()
                .map(|l| (l.vmid, l.fs_due, l.rrd_due))
                .collect()
        };
        assert_eq!(due(&p), [(100, true, true), (101, false, true)]);
        for i in 1..=6 {
            poll(&mut p, f64::from(i) * 10.0);
            let fs_due = i == 6;
            assert_eq!(due(&p), [(100, fs_due, false), (101, false, false)], "{i}");
        }
    }

    #[test]
    fn a_watched_guest_that_does_not_exist_is_harmless() {
        let mut p = fake();
        poll(&mut p, 0.0);
        assert!(p.sync_watches(&BTreeSet::from([4242])));
        assert!(p.locations(false).is_empty());
        poll(&mut p, 10.0);
        assert!(
            !p.snapshot
                .as_ref()
                .unwrap()
                .values
                .keys()
                .any(|k| k.contains("4242"))
        );
    }
}
