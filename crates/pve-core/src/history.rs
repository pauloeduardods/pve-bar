// SPDX-License-Identifier: GPL-3.0-or-later
//! The last hour of every published value, for the graphs (see
//! docs/CUSTOMIZATION.md, "History"). Kept in memory only.
//!
//! Servers are polled independently and back off on their own, so each
//! server has its own clock: one ring of poll times, and next to it one ring
//! of values per key. Every poll pushes one time and one sample to *every*
//! ring of that server (NaN when the key had no value, or the server failed),
//! so a key's ring of length `k` lines up with the last `k` poll times
//! without storing a time per sample: about 1.5 KB per key.
//!
//! Times are seconds on a monotonic clock the caller owns (pved: since it
//! started), which keeps this module pure.

use std::collections::BTreeMap;

use crate::diff::Values;
use crate::ring::{HourRing, Ring};

/// How far back the history goes, in seconds.
pub const SPAN: f64 = 3600.0;

/// A backfilled point (rrddata, one per minute) may fill a gap in a ring
/// this close to it.
const FILL_TOLERANCE: f64 = 30.0;

/// (ages in seconds before now, oldest first; values, NaN for gaps)
pub type Series = (Vec<f64>, Vec<f64>);

#[derive(Debug, Clone)]
struct KeyHistory {
    values: HourRing,
    /// Points from before the key's first recorded sample (rrddata), oldest
    /// first, on the same clock. Empty for almost every key.
    backfill: Vec<(f64, f32)>,
    /// Time of the newest finite sample: a key that has had none for
    /// [`SPAN`] (guest deleted, watch ended) is dropped.
    last_seen: f64,
}

impl KeyHistory {
    fn new(now: f64) -> Self {
        Self {
            values: HourRing::new(),
            backfill: Vec::new(),
            last_seen: now,
        }
    }
}

/// One server's history.
#[derive(Debug, Clone, Default)]
pub struct ServerHistory {
    times: Ring<360, f64>,
    keys: BTreeMap<String, KeyHistory>,
}

impl ServerHistory {
    /// Records one poll at `now`: `values` are the server's values, or None
    /// when the poll failed (every key gets a gap).
    pub fn record(&mut self, now: f64, values: Option<&Values>) {
        self.times.push(now);
        for (key, h) in &mut self.keys {
            let v = values.and_then(|m| m.get(key)).copied().unwrap_or(f64::NAN);
            h.values.push(v as f32);
            if v.is_finite() {
                h.last_seen = now;
            }
        }
        if let Some(values) = values {
            for (key, v) in values {
                if !self.keys.contains_key(key) {
                    let mut h = KeyHistory::new(now);
                    h.values.push(*v as f32);
                    self.keys.insert(key.clone(), h);
                }
            }
        }
        let oldest = now - SPAN;
        self.keys.retain(|_, h| {
            h.backfill.retain(|(t, _)| *t >= oldest);
            h.last_seen >= oldest
        });
    }

    /// Poll times of a ring of length `len`, oldest first.
    fn times_of(&self, len: usize) -> impl Iterator<Item = f64> + '_ {
        let offset = self.times.len() - len;
        (0..len).filter_map(move |i| self.times.get(offset + i))
    }

    /// Adds points from before pved watched (Proxmox's own rrd data, at
    /// `(time, value)` on this clock): they fill the key's gaps they fall on
    /// and become the part of the hour before its first sample. Creates the
    /// key if needed, so a detail key shows its hour at once.
    pub fn backfill(&mut self, key: &str, points: &[(f64, f64)], now: f64) {
        let mut points: Vec<(f64, f32)> = points
            .iter()
            .filter(|(t, _)| *t <= now && *t >= now - SPAN)
            .map(|(t, v)| (*t, *v as f32))
            .collect();
        points.sort_by(|a, b| a.0.total_cmp(&b.0));
        let newest_finite = points
            .iter()
            .rev()
            .find(|(_, v)| v.is_finite())
            .map(|p| p.0);
        if !self.keys.contains_key(key) {
            if newest_finite.is_none() {
                return;
            }
            self.keys
                .insert(key.to_owned(), KeyHistory::new(f64::NEG_INFINITY));
        }
        let len = self.keys.get(key).map_or(0, |h| h.values.len());
        let times: Vec<f64> = self.times_of(len).collect();
        let Some(h) = self.keys.get_mut(key) else {
            return;
        };
        for (i, t) in times.iter().enumerate() {
            let Some(slot) = h.values.get_mut(i) else {
                break;
            };
            if slot.is_nan()
                && let Some(p) = nearest(&points, *t).filter(|p| (p.0 - t).abs() <= FILL_TOLERANCE)
            {
                *slot = p.1;
            }
        }
        let first = times.first().copied().unwrap_or(f64::INFINITY);
        h.backfill = points.into_iter().filter(|(t, _)| *t < first).collect();
        if let Some(t) = newest_finite {
            h.last_seen = h.last_seen.max(t);
        }
    }

    /// The last hour of `key` as seen at `now`.
    pub fn series(&self, key: &str, now: f64) -> Option<Series> {
        let h = self.keys.get(key)?;
        let samples = h
            .backfill
            .iter()
            .copied()
            .chain(self.times_of(h.values.len()).zip(h.values.iter()));
        let (ages, values) = samples
            .filter(|(t, _)| now - t <= SPAN)
            .map(|(t, v)| ((now - t).max(0.0), f64::from(v)))
            .unzip();
        Some((ages, values))
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.keys.keys().map(String::as_str)
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }
}

fn nearest(points: &[(f64, f32)], t: f64) -> Option<(f64, f32)> {
    let i = points.partition_point(|p| p.0 < t);
    let after = points.get(i).copied();
    let before = i.checked_sub(1).and_then(|j| points.get(j)).copied();
    match (before, after) {
        (Some(b), Some(a)) => Some(if t - b.0 <= a.0 - t { b } else { a }),
        (b, a) => b.or(a),
    }
}

/// Every server's history, by server name (the first part of each key).
#[derive(Debug, Clone, Default)]
pub struct History {
    servers: BTreeMap<String, ServerHistory>,
}

fn server_of(key: &str) -> &str {
    key.split('/').next().unwrap_or(key)
}

impl History {
    pub fn server(&mut self, id: &str) -> &mut ServerHistory {
        self.servers.entry(id.to_owned()).or_default()
    }

    /// Forgets the servers no longer configured.
    pub fn retain_servers(&mut self, keep: impl Fn(&str) -> bool) {
        self.servers.retain(|id, _| keep(id));
    }

    /// `GetHistory`: the requested keys (all of them when `keys` is empty);
    /// unknown keys are left out.
    pub fn query(&self, keys: &[String], now: f64) -> BTreeMap<String, Series> {
        if keys.is_empty() {
            return self
                .servers
                .values()
                .flat_map(|s| s.keys().filter_map(move |k| Some((k, s.series(k, now)?))))
                .map(|(k, s)| (k.to_owned(), s))
                .collect();
        }
        keys.iter()
            .filter_map(|k| {
                let s = self.servers.get(server_of(k))?.series(k, now)?;
                Some((k.clone(), s))
            })
            .collect()
    }

    /// Number of keys kept, for logs and tests.
    pub fn len(&self) -> usize {
        self.servers.values().map(ServerHistory::len).sum()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&str, f64)]) -> Values {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    fn nan_eq(a: &[f64], b: &[f64]) -> bool {
        a.len() == b.len()
            && a.iter()
                .zip(b)
                .all(|(x, y)| x == y || (x.is_nan() && y.is_nan()))
    }

    #[test]
    fn records_every_key_oldest_first_with_gaps() {
        let mut h = ServerHistory::default();
        h.record(0.0, Some(&values(&[("s/a", 1.0)])));
        h.record(10.0, Some(&values(&[("s/a", 2.0), ("s/b", 5.0)])));
        h.record(20.0, None);
        h.record(30.0, Some(&values(&[("s/b", 6.0)])));
        let (ages, a) = h.series("s/a", 30.0).unwrap();
        assert_eq!(ages, [30.0, 20.0, 10.0, 0.0]);
        assert!(nan_eq(&a, &[1.0, 2.0, f64::NAN, f64::NAN]));
        let (ages, b) = h.series("s/b", 35.0).unwrap();
        assert_eq!(
            ages,
            [25.0, 15.0, 5.0],
            "a newer key lines up with the last polls"
        );
        assert!(nan_eq(&b, &[5.0, f64::NAN, 6.0]));
        assert!(h.series("s/c", 30.0).is_none());
    }

    #[test]
    fn keeps_one_hour_at_ten_seconds() {
        let mut h = ServerHistory::default();
        for i in 0..1000 {
            h.record(f64::from(i) * 10.0, Some(&values(&[("s/a", f64::from(i))])));
        }
        let (ages, v) = h.series("s/a", 9990.0).unwrap();
        assert_eq!(ages.len(), 360);
        assert_eq!(ages[0], 3590.0);
        assert_eq!(v[0], 640.0);
    }

    #[test]
    fn samples_older_than_an_hour_are_left_out() {
        // Backed off to 120 s: 360 polls would be 12 hours.
        let mut h = ServerHistory::default();
        for i in 0..100 {
            h.record(f64::from(i) * 120.0, Some(&values(&[("s/a", 1.0)])));
        }
        let (ages, _) = h.series("s/a", 99.0 * 120.0).unwrap();
        assert_eq!(ages.len(), 31);
        assert!(ages[0] <= SPAN);
    }

    #[test]
    fn a_key_is_dropped_after_an_hour_of_gaps() {
        let mut h = ServerHistory::default();
        h.record(0.0, Some(&values(&[("s/gone", 1.0), ("s/kept", 1.0)])));
        for i in 1..=360 {
            h.record(f64::from(i) * 10.0, Some(&values(&[("s/kept", 1.0)])));
        }
        assert!(h.series("s/gone", 3600.0).is_some(), "exactly an hour");
        h.record(3610.0, Some(&values(&[("s/kept", 1.0)])));
        assert!(h.series("s/gone", 3610.0).is_none());
        assert_eq!(h.len(), 1);
        // A failing server keeps its keys for the hour too.
        for i in 0..=360 {
            h.record(3620.0 + f64::from(i) * 10.0, None);
        }
        assert!(h.is_empty());
    }

    #[test]
    fn backfill_goes_before_the_first_sample_and_fills_gaps() {
        let mut h = ServerHistory::default();
        let now = 4000.0;
        h.record(3940.0, None);
        h.record(3950.0, Some(&values(&[("s/cpu", 7.0)])));
        h.record(3960.0, None);
        h.record(3970.0, Some(&values(&[("s/cpu", 8.0)])));
        let rrd: Vec<(f64, f64)> = (0..70)
            .map(|i| (40.0 + f64::from(i) * 60.0, 50.0))
            .collect();
        h.backfill("s/cpu", &rrd, now);
        let (ages, v) = h.series("s/cpu", now).unwrap();
        // rrd points from 400 s (an hour before now) up to 3940, just
        // before the key's first sample at 3950.
        let back = ages.len() - 3;
        assert_eq!(ages[0], 3600.0);
        assert_eq!(ages[back - 1], now - 3940.0);
        assert!(v[..back].iter().all(|v| *v == 50.0));
        // The gap at 3960 had an rrd point (3940) within 30 s.
        assert_eq!(&v[back..], &[7.0, 50.0, 8.0]);
    }

    #[test]
    fn backfill_creates_a_detail_key_and_keeps_it_aligned() {
        let mut h = ServerHistory::default();
        h.record(100.0, Some(&values(&[("s/cpu", 1.0)])));
        h.backfill("s/netin", &[(40.0, 10.0), (99.0, 20.0)], 100.0);
        h.backfill("s/nothing", &[(40.0, f64::NAN)], 100.0);
        assert!(h.series("s/nothing", 100.0).is_none(), "no data, no key");
        // First poll after the watch: no rate yet. Second: a rate.
        h.record(110.0, Some(&values(&[("s/cpu", 1.0)])));
        h.record(120.0, Some(&values(&[("s/cpu", 1.0), ("s/netin", 30.0)])));
        let (ages, v) = h.series("s/netin", 120.0).unwrap();
        assert_eq!(ages, [80.0, 21.0, 10.0, 0.0]);
        assert!(nan_eq(&v, &[10.0, 20.0, f64::NAN, 30.0]));
    }

    #[test]
    fn query_by_key_or_everything() {
        let mut all = History::default();
        all.server("home")
            .record(5.0, Some(&values(&[("home/a", 1.0)])));
        all.server("lab")
            .record(0.0, Some(&values(&[("lab/b", 2.0)])));
        let got = all.query(&["lab/b".into(), "lab/zzz".into(), "nope/x".into()], 10.0);
        assert_eq!(got.len(), 1);
        assert_eq!(got["lab/b"], (vec![10.0], vec![2.0]));
        let every = all.query(&[], 10.0);
        assert_eq!(every.keys().collect::<Vec<_>>(), ["home/a", "lab/b"]);
        assert_eq!(every["home/a"].0, [5.0], "each server has its own clock");
        all.retain_servers(|id| id == "lab");
        assert_eq!(all.len(), 1);
    }

    #[test]
    fn nearest_point() {
        let p = [(0.0, 1.0), (60.0, 2.0)];
        assert_eq!(nearest(&p, 20.0), Some((0.0, 1.0)));
        assert_eq!(nearest(&p, 40.0), Some((60.0, 2.0)));
        assert_eq!(nearest(&p, 99.0), Some((60.0, 2.0)));
        assert_eq!(nearest(&[], 1.0), None);
    }
}
