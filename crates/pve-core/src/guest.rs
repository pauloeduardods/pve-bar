// SPDX-License-Identifier: GPL-3.0-or-later
//! Per-guest details, fetched only while a client watches the guest (see
//! docs/CUSTOMIZATION.md, "Per-guest details"):
//!
//! - `GET /nodes/{node}/{qemu|lxc}/{vmid}/status/current`: uptime, limits
//!   and the network and disk byte counters, turned into rates here;
//! - `GET /nodes/{node}/qemu/{vmid}/agent/get-fsinfo`: how full the guest's
//!   own filesystems are;
//! - `GET .../rrddata?timeframe=hour&cf=AVERAGE`: Proxmox's own last hour,
//!   used once to backfill the graphs when a watch starts.
//!
//! Only the fields used are parsed; unknown fields are ignored.

use serde::Deserialize;
use serde_json::Value;

use crate::diff::{Values, round_to};

/// The counters of `status/current` that become rates (bytes/s), in the
/// order of [`Counters::bytes`]; also their value key suffixes.
pub const RATE_KEYS: [&str; 4] = ["netin", "netout", "diskread", "diskwrite"];

/// Every detail key suffix (`<server>/guest/<vmid>/<suffix>`).
pub const DETAIL_KEYS: [&str; 8] = [
    "uptime",
    "netin",
    "netout",
    "diskread",
    "diskwrite",
    "maxmem",
    "maxcpu",
    "fs",
];

/// Proxmox flags come as 0/1, true/false or "1" depending on the version.
fn flag<'de, D: serde::Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Bool(b) => b,
        Value::Number(n) => n.as_f64().unwrap_or(0.0) != 0.0,
        Value::String(s) => s == "1",
        _ => false,
    })
}

/// The reply of `status/current` (qemu and lxc share these fields).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct GuestStatus {
    /// `running`, `stopped`, ...
    pub status: String,
    /// Seconds.
    pub uptime: Option<f64>,
    /// Number of vCPUs.
    pub cpus: Option<f64>,
    /// Bytes.
    pub maxmem: Option<f64>,
    /// Byte counters since the guest started.
    pub netin: Option<f64>,
    pub netout: Option<f64>,
    pub diskread: Option<f64>,
    pub diskwrite: Option<f64>,
    /// qemu: the guest agent is enabled in the VM config.
    #[serde(deserialize_with = "flag")]
    pub agent: bool,
}

impl GuestStatus {
    /// Whether `get-fsinfo` can answer at all: a running VM with the agent on.
    pub fn agent_usable(&self) -> bool {
        self.status == "running" && self.agent
    }
}

#[derive(Debug, Deserialize)]
struct Envelope<T> {
    data: T,
}

pub fn parse_status(body: &[u8]) -> Result<GuestStatus, String> {
    serde_json::from_slice::<Envelope<GuestStatus>>(body)
        .map(|e| e.data)
        .map_err(|e| format!("unexpected reply from status/current: {e}"))
}

/// One point of `rrddata` (one per minute for `timeframe=hour`). A minute
/// with no data has only `time`.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct RrdPoint {
    /// Unix time, seconds.
    pub time: f64,
    /// Fraction of `maxcpu`, 0.0 to 1.0.
    pub cpu: Option<f64>,
    pub mem: Option<f64>,
    pub maxmem: Option<f64>,
    /// Already rates (bytes/s, averaged over the minute).
    pub netin: Option<f64>,
    pub netout: Option<f64>,
}

pub fn parse_rrd(body: &[u8]) -> Result<Vec<RrdPoint>, String> {
    serde_json::from_slice::<Envelope<Vec<RrdPoint>>>(body)
        .map(|e| e.data)
        .map_err(|e| format!("unexpected reply from rrddata: {e}"))
}

/// The backfill series of a guest from its rrd points: `(suffix, [(unix
/// time, value)])` for `cpu`, `mem`, `netin` and `netout`, rounded like the
/// live values; a minute without data is a NaN gap.
pub fn rrd_series(points: &[RrdPoint]) -> Vec<(&'static str, Vec<(f64, f64)>)> {
    let series = |f: &dyn Fn(&RrdPoint) -> Option<f64>| {
        points
            .iter()
            .map(|p| (p.time, f(p).filter(|v| v.is_finite()).unwrap_or(f64::NAN)))
            .collect::<Vec<_>>()
    };
    vec![
        ("cpu", series(&|p| p.cpu.map(|c| round_to(c * 100.0, 0.1)))),
        (
            "mem",
            series(&|p| match (p.mem, p.maxmem) {
                (Some(m), Some(t)) if t > 0.0 => Some(round_to(m * 100.0 / t, 1.0)),
                _ => None,
            }),
        ),
        ("netin", series(&|p| p.netin.map(round_rate))),
        ("netout", series(&|p| p.netout.map(round_rate))),
    ]
}

/// Filesystem types that are not the guest's disks: memory, snaps, CDs,
/// container layers and kernel interfaces.
fn is_virtual(kind: &str) -> bool {
    const VIRTUAL: [&str; 18] = [
        "tmpfs", "devtmpfs", "ramfs", "squashfs", "overlay", "iso9660", "udf", "cdfs", "proc",
        "sysfs", "cgroup", "cgroup2", "autofs", "devpts", "nsfs", "efivarfs", "tracefs", "debugfs",
    ];
    let kind = kind.to_ascii_lowercase();
    VIRTUAL.contains(&kind.as_str()) || kind.starts_with("fuse")
}

#[derive(Debug, Deserialize)]
struct FsInfo {
    #[serde(default)]
    name: String,
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(rename = "used-bytes")]
    used: Option<f64>,
    #[serde(rename = "total-bytes")]
    total: Option<f64>,
}

#[derive(Debug, Deserialize)]
struct AgentResult<T> {
    result: T,
}

/// `% used` of all the guest's real filesystems from `agent/get-fsinfo`.
/// A device mounted twice (bind mounts, btrfs subvolumes) counts once.
/// None when nothing usable was reported.
pub fn parse_fsinfo(body: &[u8]) -> Result<Option<f64>, String> {
    let list = serde_json::from_slice::<Envelope<AgentResult<Vec<FsInfo>>>>(body)
        .map_err(|e| format!("unexpected reply from get-fsinfo: {e}"))?
        .data
        .result;
    let mut seen = std::collections::BTreeSet::new();
    let (mut used, mut total) = (0.0, 0.0);
    for fs in list {
        let (Some(u), Some(t)) = (fs.used, fs.total) else {
            continue;
        };
        if t <= 0.0 || is_virtual(&fs.kind) || !seen.insert(fs.name) {
            continue;
        }
        used += u;
        total += t;
    }
    Ok((total > 0.0).then(|| round_to(used * 100.0 / total, 1.0)))
}

/// Rates span B/s to GB/s: three significant digits (whole bytes below
/// 1000) are all a label shows, and they keep `Updated` quiet.
pub fn round_rate(v: f64) -> f64 {
    if !v.is_finite() || v.abs() < 1000.0 {
        return v.round();
    }
    let step = 10f64.powi(v.abs().log10().floor() as i32 - 2);
    (v / step).round() * step
}

/// The byte counters of one `status/current`, and when they were read (on
/// the caller's monotonic clock).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Counters {
    pub at: f64,
    pub bytes: [Option<f64>; 4],
}

impl Counters {
    pub fn of(status: &GuestStatus, at: f64) -> Self {
        Self {
            at,
            bytes: [
                status.netin,
                status.netout,
                status.diskread,
                status.diskwrite,
            ],
        }
    }

    /// Bytes/s from `prev` to `self`, per [`RATE_KEYS`]. None for a counter
    /// that went backwards (the guest restarted) or without elapsed time.
    pub fn rates(&self, prev: &Counters) -> [Option<f64>; 4] {
        let dt = self.at - prev.at;
        let mut out = [None; 4];
        if dt <= 0.0 {
            return out;
        }
        for (i, slot) in out.iter_mut().enumerate() {
            if let (Some(now), Some(before)) = (self.bytes[i], prev.bytes[i])
                && now >= before
            {
                *slot = Some(round_rate((now - before) / dt));
            }
        }
        out
    }
}

/// The detail values of one guest (`uptime`, `maxmem`, `maxcpu`, and the
/// rates when there is a previous reading), keyed `<prefix><suffix>` where
/// `prefix` is `<server>/guest/<vmid>/`.
pub fn detail_values(
    prefix: &str,
    status: &GuestStatus,
    now: &Counters,
    prev: Option<&Counters>,
) -> Values {
    let mut v = Values::new();
    let mut put = |suffix: &str, value: Option<f64>| {
        if let Some(x) = value.filter(|x| x.is_finite()) {
            v.insert(format!("{prefix}{suffix}"), x);
        }
    };
    put("uptime", status.uptime.map(f64::round));
    put("maxmem", status.maxmem);
    put("maxcpu", status.cpus);
    if let Some(prev) = prev {
        for (suffix, rate) in RATE_KEYS.iter().zip(now.rates(prev)) {
            put(suffix, rate);
        }
    }
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `GET /nodes/pve/qemu/101/status/current`, Proxmox VE 8.2.
    const QEMU_STATUS: &str = r#"{"data":{
        "status":"running","vmid":101,"name":"win11","qmpstatus":"running",
        "uptime":86461,"cpu":0.0423,"cpus":4,"mem":4294967296,"maxmem":8589934592,
        "freemem":2147483648,"balloon":8589934592,"ballooninfo":{"actual":8589934592},
        "disk":0,"maxdisk":68719476736,"diskread":1234567890,"diskwrite":987654321,
        "netin":123456789,"netout":98765432,"pid":12345,"agent":1,
        "running-machine":"pc-q35-8.1+pve0","running-qemu":"8.1.5","ha":{"managed":0},
        "proxmox-support":{"backup-max-workers":true,"pbs-dirty-bitmap":true},
        "nics":{"tap101i0":{"netin":123456789,"netout":98765432}},
        "blockstat":{"scsi0":{"rd_bytes":1234567890,"wr_bytes":987654321}}}}"#;

    /// `GET /nodes/pve/lxc/200/status/current`.
    const LXC_STATUS: &str = r#"{"data":{
        "type":"lxc","status":"running","vmid":200,"name":"dns","uptime":3600,
        "cpu":0.01,"cpus":2,"mem":104857600,"maxmem":536870912,"swap":0,"maxswap":536870912,
        "disk":1073741824,"maxdisk":8589934592,"diskread":4096,"diskwrite":8192,
        "netin":1000,"netout":2000,"pid":4242,"ha":{"managed":0}}}"#;

    #[test]
    fn parses_qemu_and_lxc_status() {
        let q = parse_status(QEMU_STATUS.as_bytes()).unwrap();
        assert_eq!(q.status, "running");
        assert_eq!(q.uptime, Some(86461.0));
        assert_eq!(q.cpus, Some(4.0));
        assert_eq!(q.maxmem, Some(8589934592.0));
        assert_eq!(q.netin, Some(123456789.0));
        assert!(q.agent_usable());
        let c = parse_status(LXC_STATUS.as_bytes()).unwrap();
        assert_eq!(c.diskwrite, Some(8192.0));
        assert!(!c.agent, "containers have no agent");
        let stopped = parse_status(br#"{"data":{"status":"stopped","agent":1}}"#).unwrap();
        assert!(stopped.agent && !stopped.agent_usable());
        assert!(parse_status(b"{}").unwrap_err().contains("status/current"));
    }

    #[test]
    fn agent_flag_in_every_spelling() {
        for (json, on) in [
            (r#"{"data":{"agent":true}}"#, true),
            (r#"{"data":{"agent":0}}"#, false),
            (r#"{"data":{"agent":"1"}}"#, true),
            (r#"{"data":{}}"#, false),
        ] {
            assert_eq!(parse_status(json.as_bytes()).unwrap().agent, on);
        }
    }

    #[test]
    fn rates_from_two_readings() {
        let a = GuestStatus {
            netin: Some(1_000_000.0),
            netout: Some(500.0),
            diskread: Some(0.0),
            diskwrite: None,
            ..GuestStatus::default()
        };
        let b = GuestStatus {
            netin: Some(1_123_456.0),
            netout: Some(400.0),
            diskread: Some(0.0),
            diskwrite: Some(1.0),
            ..GuestStatus::default()
        };
        let (ca, cb) = (Counters::of(&a, 100.0), Counters::of(&b, 110.0));
        assert_eq!(
            cb.rates(&ca),
            [Some(12_300.0), None, Some(0.0), None],
            "netout went backwards: the guest restarted"
        );
        assert_eq!(cb.rates(&cb), [None; 4], "no time passed");
    }

    #[test]
    fn detail_values_first_poll_has_no_rates() {
        let s = parse_status(QEMU_STATUS.as_bytes()).unwrap();
        let first = Counters::of(&s, 0.0);
        let v = detail_values("home/guest/101/", &s, &first, None);
        let keys: Vec<_> = v.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            [
                "home/guest/101/maxcpu",
                "home/guest/101/maxmem",
                "home/guest/101/uptime"
            ]
        );
        let mut later = s.clone();
        later.netin = s.netin.map(|n| n + 10_000.0);
        let second = Counters::of(&later, 10.0);
        let v = detail_values("home/guest/101/", &later, &second, Some(&first));
        assert_eq!(v["home/guest/101/netin"], 1000.0);
        assert_eq!(v["home/guest/101/netout"], 0.0);
        assert_eq!(v.len(), 7);
    }

    #[test]
    fn rate_rounding() {
        assert_eq!(round_rate(12.4), 12.0);
        assert_eq!(round_rate(999.6), 1000.0);
        assert_eq!(round_rate(1234.0), 1230.0);
        assert_eq!(round_rate(98_765_432.0), 98_800_000.0);
        assert!(round_rate(f64::NAN).is_nan());
    }

    /// `GET /nodes/pve/qemu/101/agent/get-fsinfo`, an Ubuntu VM with snaps.
    const FSINFO_LINUX: &str = r#"{"data":{"result":[
        {"name":"sda1","mountpoint":"/","type":"ext4","used-bytes":5368709120,"total-bytes":21474836480,
         "disk":[{"bus-type":"scsi","bus":0,"target":0,"unit":0,"serial":"drive-scsi0","dev":"/dev/sda1",
                  "pci-controller":{"domain":0,"bus":9,"slot":1,"function":0}}]},
        {"name":"sda15","mountpoint":"/boot/efi","type":"vfat","used-bytes":6291456,"total-bytes":109422592,"disk":[]},
        {"name":"sda1","mountpoint":"/var/snap/x","type":"ext4","used-bytes":5368709120,"total-bytes":21474836480,"disk":[]},
        {"name":"loop0","mountpoint":"/snap/core22/1380","type":"squashfs","used-bytes":77594624,"total-bytes":77594624,"disk":[]},
        {"name":"sr0","mountpoint":"/media/cdrom","type":"iso9660","used-bytes":10,"total-bytes":10,"disk":[]},
        {"name":"gvfsd-fuse","mountpoint":"/run/user/1000/gvfs","type":"fuse.gvfsd-fuse","disk":[]}
    ]}}"#;

    /// The same from a Windows VM (virtio-win guest agent).
    const FSINFO_WINDOWS: &str = r#"{"data":{"result":[
        {"name":"\\\\?\\Volume{3a6e2a21-0000-0000-0000-100000000000}\\","mountpoint":"System Reserved",
         "type":"NTFS","used-bytes":33554432,"total-bytes":52428800,"disk":[]},
        {"name":"\\\\?\\Volume{3a6e2a21-0000-0000-0000-501f00000000}\\","mountpoint":"C:\\",
         "type":"NTFS","used-bytes":40000000000,"total-bytes":85000000000,"disk":[]},
        {"name":"\\\\?\\Volume{d64e1a2f-0000-0000-0000-000000000000}\\","mountpoint":"D:\\","type":"CDFS","disk":[]}
    ]}}"#;

    #[test]
    fn fs_percent_counts_real_filesystems_once() {
        // sda1 once + sda15: (5368709120 + 6291456) / (21474836480 + 109422592)
        assert_eq!(parse_fsinfo(FSINFO_LINUX.as_bytes()), Ok(Some(25.0)));
        assert_eq!(parse_fsinfo(FSINFO_WINDOWS.as_bytes()), Ok(Some(47.0)));
        assert_eq!(parse_fsinfo(br#"{"data":{"result":[]}}"#), Ok(None));
        // The agent not running: Proxmox answers 500, or this.
        assert!(parse_fsinfo(br#"{"data":null}"#).is_err());
    }

    /// `GET /nodes/pve/qemu/101/rrddata?timeframe=hour&cf=AVERAGE` (excerpt;
    /// 70 points in the real reply). The last minute is not complete yet.
    const RRD: &str = r#"{"data":[
        {"time":1729000020,"cpu":0.0412,"maxcpu":4,"mem":4294967296,"maxmem":8589934592,
         "disk":0,"maxdisk":68719476736,"netin":1520.53,"netout":890.21,"diskread":0,"diskwrite":4096.3},
        {"time":1729000080,"cpu":0.10049,"maxcpu":4,"mem":2147483648,"maxmem":8589934592,
         "disk":0,"maxdisk":68719476736,"netin":123456.7,"netout":0,"diskread":0,"diskwrite":0},
        {"time":1729000140}
    ]}"#;

    #[test]
    fn rrd_backfill_series() {
        let points = parse_rrd(RRD.as_bytes()).unwrap();
        assert_eq!(points.len(), 3);
        let series = rrd_series(&points);
        let names: Vec<_> = series.iter().map(|s| s.0).collect();
        assert_eq!(names, ["cpu", "mem", "netin", "netout"]);
        let cpu = &series[0].1;
        assert_eq!(cpu[0], (1729000020.0, 4.1));
        assert_eq!(cpu[1].1, 10.0);
        assert!(cpu[2].1.is_nan(), "a minute without data is a gap");
        assert_eq!(series[1].1[1].1, 25.0);
        assert_eq!(series[2].1[0].1, 1520.0);
        assert_eq!(series[2].1[1].1, 123_000.0);
        assert!(parse_rrd(b"[]").unwrap_err().contains("rrddata"));
    }
}
