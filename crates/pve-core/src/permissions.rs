// SPDX-License-Identifier: GPL-3.0-or-later
//! Checks the token's privileges (`GET /access/permissions`): pve-bar only
//! needs to read, so anything beyond `*.Audit` is reported.

use std::collections::BTreeSet;

use serde_json::Value;

/// Privileges that only read.
fn read_only(privilege: &str) -> bool {
    privilege.ends_with(".Audit")
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    /// Every privilege granted anywhere, sorted.
    pub granted: BTreeSet<String>,
    /// The ones that can change something.
    pub writable: BTreeSet<String>,
}

impl Report {
    pub fn can_read_guests(&self) -> bool {
        self.granted.contains("VM.Audit")
    }

    pub fn can_read_nodes(&self) -> bool {
        self.granted.contains("Sys.Audit")
    }
}

/// Parses `{"data": {"/": {"Sys.Audit": 1, ...}, "/vms": {...}}}`.
pub fn parse(body: &[u8]) -> Result<Report, String> {
    let json: Value = serde_json::from_slice(body)
        .map_err(|e| format!("unexpected reply from /access/permissions: {e}"))?;
    let paths = json
        .get("data")
        .and_then(Value::as_object)
        .ok_or("unexpected reply from /access/permissions: no data object")?;
    let mut report = Report::default();
    for privileges in paths.values() {
        let Some(privileges) = privileges.as_object() else {
            continue;
        };
        for (name, value) in privileges {
            let granted = match value {
                Value::Number(n) => n.as_u64().unwrap_or(0) != 0,
                Value::Bool(b) => *b,
                _ => false,
            };
            if !granted {
                continue;
            }
            report.granted.insert(name.clone());
            if !read_only(name) {
                report.writable.insert(name.clone());
            }
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auditor_is_read_only() {
        let r = parse(
            br#"{"data":{"/":{"Sys.Audit":1,"VM.Audit":1,"Datastore.Audit":1,"Pool.Audit":1,"SDN.Audit":1,"Mapping.Audit":1}}}"#,
        )
        .unwrap();
        assert!(r.writable.is_empty());
        assert!(r.can_read_guests() && r.can_read_nodes());
    }

    #[test]
    fn admin_is_reported() {
        let r = parse(
            br#"{"data":{"/":{"Sys.Audit":1},"/vms":{"VM.Audit":1,"VM.PowerMgmt":1,"VM.Console":0}}}"#,
        )
        .unwrap();
        assert_eq!(r.writable.iter().collect::<Vec<_>>(), ["VM.PowerMgmt"]);
        assert!(!r.granted.contains("VM.Console"));
    }

    #[test]
    fn nothing_granted() {
        let r = parse(br#"{"data":{}}"#).unwrap();
        assert!(!r.can_read_guests());
        assert!(parse(b"[]").is_err());
    }
}
