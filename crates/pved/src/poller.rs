// SPDX-License-Identifier: GPL-3.0-or-later
//! One Proxmox server, polled on its own schedule: its HTTP clients (created
//! lazily from the keyring), its backoff and its last good snapshot.

use std::time::Instant;

use pve_core::Snapshot;
use pve_core::backoff::Schedule;
use pve_core::config::Server;
use pve_core::fake::FakeCluster;
use pve_sys::secret::{self, Key};
use pve_sys::{FetchError, ProxmoxClient, TempClient};
use zbus::Connection;

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

pub struct Poller {
    pub id: String,
    pub source: Source,
    pub schedule: Schedule,
    pub next: Instant,
    pub state: &'static str,
    pub message: String,
    pub snapshot: Option<Snapshot>,
}

/// (state, message) for the `Servers` property.
fn failure(e: &FetchError) -> &'static str {
    match e {
        FetchError::Offline(_) | FetchError::Protocol(_) => "offline",
        FetchError::Unauthorized(_) => "unauthorized",
        FetchError::Tls(_) => "tls-error",
    }
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

    /// One poll. Updates state, snapshot and schedule; never fails.
    pub async fn poll(&mut self, conn: &Connection, locked: bool) {
        let result = match &mut self.source {
            Source::Fake(cluster) => {
                cluster.step();
                Ok(Snapshot::build(
                    &self.id,
                    &cluster.resources(),
                    Some(&cluster.temp()),
                ))
            }
            Source::Real {
                server,
                client,
                temp,
                temp_error,
            } => poll_real(conn, server, client, temp, temp_error).await,
        };
        let (state, message) = match result {
            Ok(snapshot) => {
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
}

async fn poll_real(
    conn: &Connection,
    server: &Server,
    client: &mut Option<ProxmoxClient>,
    temp: &mut Option<TempClient>,
    temp_error: &mut String,
) -> Result<Snapshot, (&'static str, String)> {
    if client.is_none() {
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
    }
    let api = client.as_ref().expect("created above");
    let (resources, report) = tokio::join!(api.resources(), async {
        match temp {
            Some(t) => Some(t.report().await),
            None => None,
        }
    });
    let resources = match resources {
        Ok(r) => r,
        Err(e) => {
            if matches!(e, FetchError::Unauthorized(_)) {
                // Read the token again next time: it may have been replaced.
                *client = None;
            }
            return Err((failure(&e), e.message().to_owned()));
        }
    };
    let host_temp = match report {
        Some(Ok(r)) => {
            if !temp_error.is_empty() {
                eprintln!("[{}] temperature agent: ok", server.id);
                temp_error.clear();
            }
            r.host_temp()
        }
        Some(Err(e)) => {
            let text = e.message().to_owned();
            if *temp_error != text {
                eprintln!("[{}] temperature agent: {text}", server.id);
                *temp_error = text;
            }
            None
        }
        None => None,
    };
    Ok(Snapshot::build(&server.id, &resources, host_temp.as_ref()))
}
