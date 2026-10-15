// SPDX-License-Identifier: GPL-3.0-or-later
//! The reply of `GET /api2/json/cluster/resources`.
//!
//! One call returns every node, VM, container and storage of the cluster.
//! Only the fields pve-bar uses are parsed; unknown fields and unknown
//! resource types are ignored, so newer Proxmox versions keep working.

use serde::Deserialize;

#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct Resource {
    /// `node`, `qemu`, `lxc`, `storage`, `sdn`, `pool`, ...
    #[serde(rename = "type")]
    pub kind: String,
    pub node: String,
    pub status: String,
    pub name: Option<String>,
    pub vmid: Option<u32>,
    /// Fraction of `maxcpu`, 0.0 to 1.0.
    pub cpu: Option<f64>,
    pub maxcpu: Option<f64>,
    pub mem: Option<u64>,
    pub maxmem: Option<u64>,
    pub disk: Option<u64>,
    pub maxdisk: Option<u64>,
    /// 1 for templates; some versions send it as a bool, see [`Resource::is_template`].
    pub template: Option<serde_json::Value>,
}

impl Resource {
    pub fn is_template(&self) -> bool {
        match &self.template {
            Some(serde_json::Value::Bool(b)) => *b,
            Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0) != 0,
            _ => false,
        }
    }
}

#[derive(Debug, Deserialize)]
struct Envelope {
    data: Vec<Resource>,
}

/// Parses the full JSON body (`{"data": [...]}`).
pub fn parse(body: &[u8]) -> Result<Vec<Resource>, String> {
    serde_json::from_slice::<Envelope>(body)
        .map(|e| e.data)
        .map_err(|e| format!("unexpected reply from /cluster/resources: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub const SAMPLE: &str = r#"{"data":[
        {"id":"node/pve","type":"node","node":"pve","status":"online","cpu":0.2345,"maxcpu":16,
         "mem":41943040000,"maxmem":68719476736,"disk":20000000000,"maxdisk":100000000000,
         "uptime":12345,"level":"","cgroup-mode":2},
        {"id":"qemu/101","type":"qemu","vmid":101,"node":"pve","name":"win11","status":"running",
         "cpu":0.871,"maxcpu":8,"mem":8589934592,"maxmem":17179869184,"template":0},
        {"id":"lxc/200","type":"lxc","vmid":200,"node":"pve","name":"dns","status":"stopped",
         "cpu":0,"maxcpu":1,"mem":0,"maxmem":536870912},
        {"id":"qemu/9000","type":"qemu","vmid":9000,"node":"pve","name":"tpl","status":"stopped",
         "template":1},
        {"id":"storage/pve/local","type":"storage","node":"pve","status":"available","storage":"local"},
        {"id":"sdn/pve/localnetwork","type":"sdn","node":"pve","status":"ok","sdn":"localnetwork"}
    ]}"#;

    #[test]
    fn parses_the_fields_it_needs_and_ignores_the_rest() {
        let r = parse(SAMPLE.as_bytes()).unwrap();
        assert_eq!(r.len(), 6);
        assert_eq!(r[0].kind, "node");
        assert_eq!(r[0].cpu, Some(0.2345));
        assert_eq!(r[1].vmid, Some(101));
        assert_eq!(r[1].name.as_deref(), Some("win11"));
        assert!(!r[1].is_template());
        assert!(r[3].is_template());
        assert_eq!(r[4].kind, "storage");
    }

    #[test]
    fn template_as_bool() {
        let r = parse(br#"{"data":[{"type":"qemu","template":true}]}"#).unwrap();
        assert!(r[0].is_template());
    }

    #[test]
    fn errors_are_readable() {
        assert!(parse(b"<html>").unwrap_err().contains("/cluster/resources"));
        assert!(parse(br#"{"data":null}"#).is_err());
    }
}
