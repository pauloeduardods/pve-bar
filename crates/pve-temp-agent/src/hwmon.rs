// SPDX-License-Identifier: GPL-3.0-or-later
//! Temperature discovery over /sys/class/hwmon and the host name, both read
//! under a configurable root so tests can point them at a fixture.

use std::fs::{self, File};
use std::io::Read;
use std::path::Path;

const HWMON_DIR: &str = "sys/class/hwmon";
const HOSTNAME_FILE: &str = "proc/sys/kernel/hostname";
/// sysfs attributes are tiny; never read more than this from one file.
const MAX_FILE: u64 = 4096;
/// Readings outside this range (°C) are glitches or unconnected inputs.
const MIN_CELSIUS: f64 = -40.0;
const MAX_CELSIUS: f64 = 150.0;

/// One temperature reading.
#[derive(Debug, Clone, PartialEq)]
pub struct Sensor {
    pub chip: String,
    pub label: String,
    pub celsius: f64,
}

/// Reads a small text file, lossily decoded and trimmed.
fn read_trimmed(path: &Path) -> Option<String> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(MAX_FILE)
        .read_to_end(&mut bytes)
        .ok()?;
    Some(String::from_utf8_lossy(&bytes).trim().to_owned())
}

/// `N` from `tempN_input`.
fn temp_index(file: &str) -> Option<u32> {
    let digits = file.strip_prefix("temp")?.strip_suffix("_input")?;
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// Parses a `tempN_input` value (millidegrees) into a sane Celsius value.
fn parse_millidegrees(text: &str) -> Option<f64> {
    let milli: i64 = text.trim().parse().ok()?;
    let celsius = milli as f64 / 1000.0;
    (MIN_CELSIUS..=MAX_CELSIUS)
        .contains(&celsius)
        .then_some(celsius)
}

fn names_in(dir: &Path) -> Vec<String> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(|e| e.ok()?.file_name().into_string().ok())
        .collect()
}

/// Every readable, plausible temperature, sorted by chip then label.
/// Nothing is cached: hwmon is re-read on every call.
pub fn scan(root: &Path) -> Vec<Sensor> {
    let hwmon = root.join(HWMON_DIR);
    let mut found: Vec<(Sensor, u32)> = Vec::new();
    for entry in names_in(&hwmon) {
        if !entry.starts_with("hwmon") {
            continue;
        }
        let dir = hwmon.join(&entry);
        let Some(chip) = read_trimmed(&dir.join("name")).filter(|n| !n.is_empty()) else {
            continue;
        };
        for file in names_in(&dir) {
            let Some(n) = temp_index(&file) else {
                continue;
            };
            let Some(celsius) = read_trimmed(&dir.join(&file)).and_then(|t| parse_millidegrees(&t))
            else {
                continue;
            };
            let label = read_trimmed(&dir.join(format!("temp{n}_label")))
                .filter(|l| !l.is_empty())
                .unwrap_or_else(|| format!("temp{n}"));
            found.push((
                Sensor {
                    chip: chip.clone(),
                    label,
                    celsius,
                },
                n,
            ));
        }
    }
    found.sort_by(|(a, ai), (b, bi)| (&a.chip, &a.label, ai).cmp(&(&b.chip, &b.label, bi)));
    found.into_iter().map(|(s, _)| s).collect()
}

/// The host name, which is the Proxmox node name.
pub fn hostname(root: &Path) -> Option<String> {
    read_trimmed(&root.join(HOSTNAME_FILE)).filter(|h| !h.is_empty())
}

#[cfg(test)]
pub(crate) mod fixture {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU32, Ordering};

    /// A fake sysfs root under the temp dir, removed on drop.
    pub struct Fixture {
        pub root: PathBuf,
    }

    impl Fixture {
        pub fn new(name: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let root = std::env::temp_dir().join(format!(
                "pve-temp-agent-test-{}-{n}-{name}",
                std::process::id()
            ));
            let _ = fs::remove_dir_all(&root);
            fs::create_dir_all(&root).unwrap();
            Self { root }
        }

        pub fn write(&self, rel: &str, contents: &str) {
            let path = self.root.join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, contents).unwrap();
        }

        pub fn path(&self) -> &Path {
            &self.root
        }

        /// A typical Intel host: coretemp, an NVMe drive and a hostname.
        pub fn typical(name: &str) -> Self {
            let f = Self::new(name);
            f.write("proc/sys/kernel/hostname", "pve\n");
            f.write("sys/class/hwmon/hwmon3/name", "coretemp\n");
            f.write("sys/class/hwmon/hwmon3/temp1_input", "54000\n");
            f.write("sys/class/hwmon/hwmon3/temp1_label", "Package id 0\n");
            f.write("sys/class/hwmon/hwmon3/temp2_input", "51000\n");
            f.write("sys/class/hwmon/hwmon3/temp2_label", "Core 0\n");
            f.write("sys/class/hwmon/hwmon1/name", "nvme\n");
            f.write("sys/class/hwmon/hwmon1/temp1_input", "41850\n");
            f.write("sys/class/hwmon/hwmon1/temp1_label", "Composite\n");
            f
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixture::Fixture;
    use super::*;

    fn s(chip: &str, label: &str, celsius: f64) -> Sensor {
        Sensor {
            chip: chip.into(),
            label: label.into(),
            celsius,
        }
    }

    #[test]
    fn scans_and_sorts_by_chip_then_label() {
        let f = Fixture::typical("scan");
        assert_eq!(
            scan(f.path()),
            vec![
                s("coretemp", "Core 0", 51.0),
                s("coretemp", "Package id 0", 54.0),
                s("nvme", "Composite", 41.85),
            ]
        );
        assert_eq!(hostname(f.path()).as_deref(), Some("pve"));
    }

    #[test]
    fn skips_bad_values_and_falls_back_to_temp_n() {
        let f = Fixture::new("bad");
        f.write("sys/class/hwmon/hwmon0/name", "acpitz");
        f.write("sys/class/hwmon/hwmon0/temp1_input", "27800");
        f.write("sys/class/hwmon/hwmon0/temp2_input", "-273150");
        f.write("sys/class/hwmon/hwmon0/temp3_input", "200000");
        f.write("sys/class/hwmon/hwmon0/temp4_input", "garbage");
        f.write("sys/class/hwmon/hwmon0/temp5_input", "");
        f.write("sys/class/hwmon/hwmon0/temp6_label", "label without input");
        f.write("sys/class/hwmon/hwmon0/temp7_input", "-40000");
        f.write("sys/class/hwmon/hwmon0/temp7_label", "   ");
        f.write("sys/class/hwmon/hwmon0/tempx_input", "30000");
        f.write("sys/class/hwmon/hwmon0/temp_input", "30000");
        // No name: skipped. Not hwmonN: skipped.
        f.write("sys/class/hwmon/hwmon1/temp1_input", "30000");
        f.write("sys/class/hwmon/other/name", "x");
        f.write("sys/class/hwmon/other/temp1_input", "30000");
        assert_eq!(
            scan(f.path()),
            vec![s("acpitz", "temp1", 27.8), s("acpitz", "temp7", -40.0)]
        );
    }

    #[test]
    fn missing_tree_is_empty() {
        let f = Fixture::new("empty");
        assert!(scan(f.path()).is_empty());
        assert_eq!(hostname(f.path()), None);
    }

    #[test]
    fn index_parsing() {
        assert_eq!(temp_index("temp12_input"), Some(12));
        assert_eq!(temp_index("temp_input"), None);
        assert_eq!(temp_index("temp1_label"), None);
        assert_eq!(temp_index("temp+1_input"), None);
        assert_eq!(temp_index("fan1_input"), None);
    }
}
