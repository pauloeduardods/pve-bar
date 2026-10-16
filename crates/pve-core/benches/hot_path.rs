// SPDX-License-Identifier: GPL-3.0-or-later
//! The per-cycle hot path, timed with std only (no criterion):
//!   cargo bench -p pve-core
//! Prints the time per operation for the ring buffer, the snapshot build and
//! the diff of a 30-guest cluster, and the history.

use std::hint::black_box;
use std::time::Instant;

use pve_core::diff::diff;
use pve_core::fake::FakeCluster;
use pve_core::history::{History, ServerHistory};
use pve_core::ring::HourRing;
use pve_core::snapshot::Snapshot;

fn time<R>(name: &str, iterations: u32, mut f: impl FnMut() -> R) {
    for _ in 0..iterations / 10 {
        black_box(f());
    }
    let start = Instant::now();
    for _ in 0..iterations {
        black_box(f());
    }
    let per = start.elapsed() / iterations;
    println!("{name:<40} {per:>10.2?} per op ({iterations} iterations)");
}

fn main() {
    let mut ring = HourRing::new();
    let mut x = 0.0f32;
    time("ring push (360 points)", 10_000_000, || {
        x += 0.5;
        ring.push(x);
    });
    time("ring iterate 360 points", 100_000, || {
        ring.iter().sum::<f32>()
    });

    let mut cluster = FakeCluster::new(42, "pve", 30);
    let resources = cluster.resources();
    let temp = cluster.temp();
    time("snapshot build (1 node, 30 guests)", 100_000, || {
        Snapshot::build("home", &resources, Some(&temp))
    });

    let old = Snapshot::build("home", &resources, Some(&temp)).values;
    cluster.step();
    let new = Snapshot::build("home", &cluster.resources(), Some(&cluster.temp())).values;
    println!(
        "  values per cycle: {}, changed after one step: {}",
        new.len(),
        diff(&old, &new).len()
    );
    time("diff 62 values (one cycle of changes)", 1_000_000, || {
        diff(&old, &new)
    });
    time("diff 62 values (nothing changed)", 1_000_000, || {
        diff(&new, &new)
    });

    let mut history = ServerHistory::default();
    let mut t = 0.0;
    time("history record (one cycle, 66 keys)", 100_000, || {
        t += 10.0;
        history.record(t, Some(&new));
    });
    let keys = vec!["home/node/pve/cpu".to_owned()];
    let mut all = History::default();
    for i in 0..360 {
        all.server("home").record(f64::from(i) * 10.0, Some(&new));
    }
    time("GetHistory of one key (360 points)", 100_000, || {
        all.query(&keys, 3600.0)
    });
}
