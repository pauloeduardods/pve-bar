// SPDX-License-Identifier: GPL-3.0-or-later
//! Synthetic servers for `pved --fake`: each one node with guests whose numbers
//! wander like real ones, so the extension can be developed without Proxmox.
//! pved fakes two servers: `home` (30 guests) and `lab` (6 guests).
//! Deterministic for a given seed.

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

    pub fn temp(&self) -> HostTemp {
        HostTemp {
            node: self.node.clone(),
            celsius: self.host_temp,
        }
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
    fn deterministic() {
        let (mut a, mut b) = (FakeCluster::new(1, "n", 30), FakeCluster::new(1, "n", 30));
        for _ in 0..10 {
            a.step();
            b.step();
        }
        assert_eq!(a.resources(), b.resources());
    }
}
