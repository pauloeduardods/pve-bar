// SPDX-License-Identifier: GPL-3.0-or-later
//! Synthetic servers for `pved --fake`: each one node with guests whose numbers
//! wander like real ones, so the extension can be developed without Proxmox.
//! pved fakes two servers: `home` (30 guests) and `lab` (6 guests).
//! Deterministic for a given seed. Watched guests get details too: byte
//! counters that follow a smooth wave of the caller's clock (so the rates
//! move), a backfilled hour and, for VMs with the agent, a filesystem.

use crate::guest::{GuestStatus, RrdPoint};
use crate::resources::Resource;
use crate::snapshot::{GIB, HostTemp};

const NAMES: [&str; 30] = [
    "win11",
    "dns",
    "nextcloud",
    "jellyfin",
    "home-assistant",
    "gitea",
    "postgres",
    "redis",
    "traefik",
    "grafana",
    "prometheus",
    "minio",
    "k3s-master",
    "k3s-worker-1",
    "k3s-worker-2",
    "pihole",
    "vaultwarden",
    "immich",
    "paperless",
    "frigate",
    "mqtt",
    "unifi",
    "wireguard",
    "dev-ubuntu",
    "dev-fedora",
    "build-runner",
    "backup",
    "samba",
    "syncthing",
    "sandbox",
];

/// xorshift64*: tiny, good enough for jitter, no dependency.
#[derive(Debug, Clone)]
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Uniform in [0, 1).
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Uniform in [-1, 1).
    fn signed(&mut self) -> f64 {
        self.unit() * 2.0 - 1.0
    }
}

#[derive(Debug, Clone)]
struct FakeGuest {
    vmid: u32,
    lxc: bool,
    name: &'static str,
    running: bool,
    cpu: f64,
    mem: f64,
    maxmem: u64,
    maxcpu: f64,
}

#[derive(Debug, Clone)]
pub struct FakeCluster {
    node: String,
    rng: Rng,
    cycle: u64,
    host_temp: f64,
    host_mem: f64,
    guests: Vec<FakeGuest>,
}

const HOST_CPUS: f64 = 16.0;
const HOST_MEM: u64 = 64 * 1024 * 1024 * 1024;

fn walk(rng: &mut Rng, value: f64, step: f64, lo: f64, hi: f64) -> f64 {
    (value + rng.signed() * step).clamp(lo, hi)
}

impl FakeCluster {
    /// `guests` (at most 30) guests on one node named `node`.
    pub fn new(seed: u64, node: &str, guests: usize) -> Self {
        let mut rng = Rng(seed | 1);
        let guests = NAMES
            .iter()
            .take(guests)
            .enumerate()
            .map(|(i, name)| {
                let lxc = i % 3 == 1;
                FakeGuest {
                    vmid: 100 + i as u32,
                    lxc,
                    name,
                    running: i % 4 != 3,
                    cpu: rng.unit() * 0.4,
                    mem: 0.3 + rng.unit() * 0.5,
                    maxmem: if lxc { GIB as u64 } else { 4 * GIB as u64 },
                    maxcpu: if lxc { 2.0 } else { 4.0 },
                }
            })
            .collect();
        Self {
            node: node.to_owned(),
            rng,
            cycle: 0,
            host_temp: 52.0,
            host_mem: 0.6,
            guests,
        }
    }

    /// Advances one polling cycle.
    pub fn step(&mut self) {
        self.cycle += 1;
        let rng = &mut self.rng;
        for g in &mut self.guests {
            g.cpu = walk(rng, g.cpu, 0.08, 0.0, 1.0);
            g.mem = walk(rng, g.mem, 0.02, 0.05, 0.98);
        }
        self.host_mem = walk(rng, self.host_mem, 0.01, 0.3, 0.95);
        self.host_temp = walk(rng, self.host_temp, 1.5, 38.0, 92.0);
        // Now and then a guest starts or stops, so the list changes too.
        if self.cycle.is_multiple_of(30) && !self.guests.is_empty() {
            let i = (self.rng.next() % self.guests.len() as u64) as usize;
            self.guests[i].running = !self.guests[i].running;
        }
    }

    pub fn resources(&self) -> Vec<Resource> {
        let running: Vec<_> = self.guests.iter().filter(|g| g.running).collect();
        // Guests rarely all peak at once; a fraction of their sum looks real.
        let busy: f64 = running.iter().map(|g| g.cpu * g.maxcpu).sum();
        let host_cpu = (busy * 0.3 / HOST_CPUS + 0.03).min(1.0);
        let mut out = vec![Resource {
            kind: "node".into(),
            node: self.node.clone(),
            status: "online".into(),
            cpu: Some(host_cpu),
            maxcpu: Some(HOST_CPUS),
            mem: Some((self.host_mem * HOST_MEM as f64) as u64),
            maxmem: Some(HOST_MEM),
            disk: Some(38 * GIB as u64),
            maxdisk: Some(100 * GIB as u64),
            ..Resource::default()
        }];
        out.extend(self.guests.iter().map(|g| Resource {
            kind: if g.lxc { "lxc" } else { "qemu" }.into(),
            node: self.node.clone(),
            status: if g.running { "running" } else { "stopped" }.into(),
            name: Some(g.name.into()),
            vmid: Some(g.vmid),
            cpu: Some(if g.running { g.cpu } else { 0.0 }),
            maxcpu: Some(g.maxcpu),
            mem: Some(if g.running {
                (g.mem * g.maxmem as f64) as u64
            } else {
                0
            }),
            maxmem: Some(g.maxmem),
            ..Resource::default()
        }));
        out
    }

    fn guest(&self, vmid: u32) -> Option<&FakeGuest> {
        self.guests.iter().find(|g| g.vmid == vmid)
    }

    /// `status/current` of a guest at `t` seconds on the caller's clock.
    pub fn guest_status(&self, vmid: u32, t: f64) -> Option<GuestStatus> {
        let g = self.guest(vmid)?;
        let wave = Wave::of(vmid);
        let counter = |scale: f64| g.running.then(|| (wave.integral(t) * scale).round());
        Some(GuestStatus {
            status: if g.running { "running" } else { "stopped" }.into(),
            uptime: Some(if g.running {
                t + f64::from(vmid) * 3600.0
            } else {
                0.0
            }),
            cpus: Some(g.maxcpu),
            maxmem: Some(g.maxmem as f64),
            netin: counter(1.0),
            netout: counter(0.3),
            diskread: counter(0.05),
            diskwrite: counter(0.2),
            agent: !g.lxc && vmid.is_multiple_of(2),
        })
    }

    /// `rrddata?timeframe=hour`: 70 one-minute points ending at `unix_now`,
    /// which is `t_now` on the caller's clock.
    pub fn guest_rrd(&self, vmid: u32, unix_now: f64, t_now: f64) -> Vec<RrdPoint> {
        let Some(g) = self.guest(vmid) else {
            return Vec::new();
        };
        let wave = Wave::of(vmid);
        let end = (unix_now / 60.0).floor() * 60.0;
        (0..70)
            .map(|i| {
                let time = end - f64::from(69 - i) * 60.0;
                let t = t_now - (unix_now - time);
                let swing = (t / 600.0 + f64::from(vmid)).sin();
                RrdPoint {
                    time,
                    cpu: Some((g.cpu + 0.1 * swing).clamp(0.0, 1.0)),
                    mem: Some(((g.mem + 0.03 * swing).clamp(0.0, 1.0)) * g.maxmem as f64),
                    maxmem: Some(g.maxmem as f64),
                    netin: Some(wave.rate(t)),
                    netout: Some(wave.rate(t) * 0.3),
                }
            })
            .collect()
    }

    /// `agent/get-fsinfo` as `% used`; None for guests without the agent.
    pub fn guest_fs(&self, vmid: u32) -> Option<f64> {
        self.guest(vmid).filter(|g| g.running && !g.lxc)?;
        vmid.is_multiple_of(2)
            .then(|| (20.0 + f64::from(vmid % 60) + self.cycle as f64 * 0.01).min(99.0))
    }

    pub fn temp(&self) -> HostTemp {
        HostTemp {
            node: self.node.clone(),
            celsius: self.host_temp,
        }
    }
}

/// A byte rate that rises and falls: `base * (1.2 + sin(t / period))`,
/// never negative, so its integral (the counter) only grows.
#[derive(Debug, Clone, Copy)]
struct Wave {
    base: f64,
    period: f64,
}

impl Wave {
    fn of(vmid: u32) -> Self {
        Self {
            base: 2_000.0 + f64::from(vmid % 7) * 15_000.0,
            period: 60.0 + f64::from(vmid % 5) * 40.0,
        }
    }

    fn rate(self, t: f64) -> f64 {
        self.base * (1.2 + (t / self.period).sin())
    }

    fn integral(self, t: f64) -> f64 {
        self.base * (1.2 * t + self.period * (1.0 - (t / self.period).cos()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::Snapshot;

    #[test]
    fn thirty_guests_on_one_node() {
        let f = FakeCluster::new(42, "pve", 30);
        let s = Snapshot::build("home", &f.resources(), Some(&f.temp()));
        assert_eq!(s.nodes.len(), 1);
        assert_eq!(s.guests.len(), 30);
        assert!(s.guests.iter().any(|g| g.kind == "lxc"));
        assert!(s.guests.iter().any(|g| g.status == "stopped"));
        assert!(s.values.contains_key("home/node/pve/temp"));
        assert_eq!(FakeCluster::new(1, "lab1", 6).resources().len(), 7);
    }

    #[test]
    fn values_stay_in_range_and_move() {
        let mut f = FakeCluster::new(7, "pve", 30);
        let first = Snapshot::build("x", &f.resources(), None);
        for _ in 0..500 {
            f.step();
            let s = Snapshot::build("x", &f.resources(), Some(&f.temp()));
            for (k, v) in &s.values {
                if k.ends_with("/cpu") || k.ends_with("/mem") || k.ends_with("/disk") {
                    assert!((0.0..=100.0).contains(v), "{k} = {v}");
                }
            }
            assert!((38.0..=92.0).contains(&s.values["x/node/pve/temp"]));
        }
        assert_ne!(
            first.values,
            Snapshot::build("x", &f.resources(), None).values
        );
    }

    #[test]
    fn watched_guests_have_details() {
        use crate::guest::{Counters, rrd_series};
        let f = FakeCluster::new(42, "pve", 30);
        let vm = f.guest_status(100, 50.0).unwrap();
        assert_eq!(vm.status, "running");
        assert!(vm.agent_usable());
        assert_eq!(vm.cpus, Some(4.0));
        let later = f.guest_status(100, 60.0).unwrap();
        let rates = Counters::of(&later, 60.0).rates(&Counters::of(&vm, 50.0));
        assert!(
            rates.iter().all(|r| r.is_some_and(|r| r > 0.0)),
            "{rates:?}"
        );
        assert!(f.guest_fs(100).is_some());
        let ct = f.guest_status(101, 50.0).unwrap();
        assert!(!ct.agent);
        assert_eq!(f.guest_fs(101), None);
        let stopped = f.guest_status(103, 50.0).unwrap();
        assert_eq!((stopped.status.as_str(), stopped.netin), ("stopped", None));
        assert!(f.guest_status(999, 0.0).is_none());

        let rrd = f.guest_rrd(100, 1_729_000_000.0, 500.0);
        assert_eq!(rrd.len(), 70);
        assert!(rrd.windows(2).all(|w| w[1].time - w[0].time == 60.0));
        assert!(
            rrd_series(&rrd)
                .iter()
                .all(|(_, s)| s.iter().all(|p| p.1.is_finite()))
        );
    }

    #[test]
    fn counters_only_grow() {
        let w = Wave::of(104);
        let mut last = w.integral(0.0);
        for i in 1..2000 {
            let now = w.integral(f64::from(i) * 3.0);
            assert!(now > last);
            last = now;
        }
    }

    #[test]
    fn deterministic() {
        let (mut a, mut b) = (FakeCluster::new(1, "n", 30), FakeCluster::new(1, "n", 30));
        for _ in 0..10 {
            a.step();
            b.step();
        }
        assert_eq!(a.resources(), b.resources());
    }
}
