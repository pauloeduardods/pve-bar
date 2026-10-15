// SPDX-License-Identifier: GPL-3.0-or-later
//! One polling cycle turned into what pved publishes: the node list, the
//! guest list and the rounded value map (see docs/ARCHITECTURE.md, value keys).

use crate::diff::{Values, round_to};
use crate::resources::Resource;

pub const GIB: f64 = 1024.0 * 1024.0 * 1024.0;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    /// The `[name]` of the server in pved.conf.
    pub server: String,
    pub name: String,
    /// `online`, `offline` or `unknown`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Guest {
    pub server: String,
    pub vmid: u32,
    /// `qemu` or `lxc`.
    pub kind: String,
    pub node: String,
    pub name: String,
    /// `running`, `stopped`, `paused`, ...
    pub status: String,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Snapshot {
    pub nodes: Vec<Node>,
    pub guests: Vec<Guest>,
    pub values: Values,
}

/// A host temperature already picked from the agent's reply.
#[derive(Debug, Clone, PartialEq)]
pub struct HostTemp {
    pub node: String,
    pub celsius: f64,
}

fn percent(used: Option<u64>, total: Option<u64>) -> Option<f64> {
    match (used, total) {
        (Some(u), Some(t)) if t > 0 => Some(u as f64 * 100.0 / t as f64),
        _ => None,
    }
}

fn put(values: &mut Values, key: String, value: Option<f64>, step: f64) {
    if let Some(v) = value.filter(|v| v.is_finite()) {
        values.insert(key, round_to(v, step));
    }
}

impl Snapshot {
    /// One server's resources; every key starts with `<server>/`.
    pub fn build(server: &str, resources: &[Resource], temp: Option<&HostTemp>) -> Self {
        let mut snap = Snapshot::default();
        for r in resources {
            match r.kind.as_str() {
                "node" => snap.add_node(server, r),
                "qemu" | "lxc" if !r.is_template() => snap.add_guest(server, r),
                _ => {}
            }
        }
        if let Some(t) = temp
            && snap.nodes.iter().any(|n| n.name == t.node)
        {
            put(
                &mut snap.values,
                format!("{server}/node/{}/temp", t.node),
                Some(t.celsius),
                1.0,
            );
        }
        snap.nodes.sort_by(|a, b| a.name.cmp(&b.name));
        snap.guests.sort_by_key(|g| g.vmid);
        snap
    }

    /// Merges another server's snapshot (servers are polled separately).
    pub fn extend(&mut self, other: Snapshot) {
        self.nodes.extend(other.nodes);
        self.guests.extend(other.guests);
        self.values.extend(other.values);
    }

    fn add_node(&mut self, server: &str, r: &Resource) {
        let status = match r.status.as_str() {
            "online" | "offline" => r.status.clone(),
            _ => "unknown".to_owned(),
        };
        let online = status == "online";
        self.nodes.push(Node {
            server: server.to_owned(),
            name: r.node.clone(),
            status,
        });
        if !online {
            // An offline node keeps its last numbers in the API; they are stale.
            return;
        }
        let v = &mut self.values;
        let key = |m: &str| format!("{server}/node/{}/{m}", r.node);
        put(v, key("cpu"), r.cpu.map(|c| c * 100.0), 0.1);
        put(v, key("mem"), percent(r.mem, r.maxmem), 1.0);
        put(v, key("mem_used"), r.mem.map(|m| m as f64), GIB / 10.0);
        put(v, key("mem_total"), r.maxmem.map(|m| m as f64), GIB / 10.0);
        put(v, key("disk"), percent(r.disk, r.maxdisk), 1.0);
    }

    fn add_guest(&mut self, server: &str, r: &Resource) {
        let Some(vmid) = r.vmid else { return };
        let running = r.status == "running";
        self.guests.push(Guest {
            server: server.to_owned(),
            vmid,
            kind: r.kind.clone(),
            node: r.node.clone(),
            name: r
                .name
                .clone()
                .unwrap_or_else(|| format!("{}-{vmid}", r.kind)),
            status: if r.status.is_empty() {
                "unknown".to_owned()
            } else {
                r.status.clone()
            },
        });
        let v = &mut self.values;
        let (cpu, mem) = if running {
            (
                r.cpu.map(|c| c * 100.0).unwrap_or(0.0),
                percent(r.mem, r.maxmem).unwrap_or(0.0),
            )
        } else {
            (0.0, 0.0)
        };
        put(v, format!("{server}/guest/{vmid}/cpu"), Some(cpu), 0.1);
        put(v, format!("{server}/guest/{vmid}/mem"), Some(mem), 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::resources::parse;

    const SAMPLE: &str = r#"{"data":[
        {"type":"node","node":"pve","status":"online","cpu":0.23449,"maxcpu":16,
         "mem":41943040000,"maxmem":68719476736,"disk":20000000000,"maxdisk":100000000000},
        {"type":"node","node":"pve2","status":"offline","cpu":0.5,"mem":1,"maxmem":2},
        {"type":"qemu","vmid":101,"node":"pve","name":"win11","status":"running",
         "cpu":0.871,"maxcpu":8,"mem":8589934592,"maxmem":17179869184,"template":0},
        {"type":"lxc","vmid":100,"node":"pve","name":"dns","status":"stopped",
         "cpu":0.3,"mem":10,"maxmem":100},
        {"type":"qemu","vmid":9000,"node":"pve","name":"tpl","status":"stopped","template":1},
        {"type":"storage","node":"pve","status":"available"}
    ]}"#;

    fn snap(temp: Option<HostTemp>) -> Snapshot {
        Snapshot::build("home", &parse(SAMPLE.as_bytes()).unwrap(), temp.as_ref())
    }

    #[test]
    fn nodes_and_guests_sorted_templates_left_out() {
        let s = snap(None);
        let names: Vec<_> = s.nodes.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(names, ["pve", "pve2"]);
        let ids: Vec<_> = s.guests.iter().map(|g| g.vmid).collect();
        assert_eq!(ids, [100, 101]);
        assert_eq!(s.guests[0].kind, "lxc");
        assert_eq!(s.guests[0].server, "home");
        assert_eq!(s.nodes[0].server, "home");
        assert_eq!(s.guests[1].name, "win11");
    }

    #[test]
    fn host_values_are_rounded() {
        let v = snap(None).values;
        assert_eq!(v["home/node/pve/cpu"], 23.4);
        assert_eq!(v["home/node/pve/mem"], 61.0);
        assert_eq!(v["home/node/pve/disk"], 20.0);
        assert_eq!(v["home/node/pve/mem_total"], 64.0 * GIB);
        assert_eq!(
            v["home/node/pve/mem_used"],
            round_to(41943040000.0, GIB / 10.0)
        );
    }

    #[test]
    fn offline_node_has_no_values() {
        let v = snap(None).values;
        assert!(!v.keys().any(|k| k.starts_with("home/node/pve2/")));
    }

    #[test]
    fn guest_values_and_stopped_guests_are_zero() {
        let v = snap(None).values;
        assert_eq!(v["home/guest/101/cpu"], 87.1);
        assert_eq!(v["home/guest/101/mem"], 50.0);
        assert_eq!(v["home/guest/100/cpu"], 0.0);
        assert_eq!(v["home/guest/100/mem"], 0.0);
        assert!(!v.contains_key("home/guest/9000/cpu"));
    }

    #[test]
    fn temperature_only_for_a_known_node() {
        let t = |node: &str| {
            Some(HostTemp {
                node: node.to_owned(),
                celsius: 54.4,
            })
        };
        assert_eq!(snap(t("pve")).values["home/node/pve/temp"], 54.0);
        assert!(!snap(t("other")).values.keys().any(|k| k.ends_with("/temp")));
        assert!(!snap(None).values.keys().any(|k| k.ends_with("/temp")));
    }

    #[test]
    fn servers_merge_without_clashing() {
        let r = parse(SAMPLE.as_bytes()).unwrap();
        let mut all = Snapshot::build("home", &r, None);
        all.extend(Snapshot::build("lab", &r, None));
        assert_eq!(all.guests.len(), 4);
        assert_eq!(all.values["home/guest/101/cpu"], 87.1);
        assert_eq!(all.values["lab/guest/101/cpu"], 87.1);
    }

    #[test]
    fn guest_without_name() {
        let r = parse(br#"{"data":[{"type":"lxc","vmid":7,"node":"n","status":""}]}"#).unwrap();
        let s = Snapshot::build("x", &r, None);
        assert_eq!(s.guests[0].name, "lxc-7");
        assert_eq!(s.guests[0].status, "unknown");
    }
}
