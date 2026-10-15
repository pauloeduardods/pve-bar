// SPDX-License-Identifier: GPL-3.0-or-later
//! The pve-temp-agent reply, and which sensor is "the CPU".

use serde::Deserialize;

use crate::snapshot::HostTemp;

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct Sensor {
    pub chip: String,
    pub label: String,
    pub celsius: f64,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct TempReport {
    pub schema: u32,
    pub node: String,
    pub sensors: Vec<Sensor>,
}

pub fn parse(body: &[u8]) -> Result<TempReport, String> {
    let report: TempReport = serde_json::from_slice(body)
        .map_err(|e| format!("unexpected reply from the temperature agent: {e}"))?;
    if report.schema != 1 {
        return Err(format!(
            "temperature agent speaks schema {}, expected 1; update pve-bar or the agent",
            report.schema
        ));
    }
    Ok(report)
}

const CPU_CHIPS: [&str; 3] = ["coretemp", "k10temp", "zenpower"];

/// `coretemp` "Package id 0", else `k10temp` "Tctl"/"Tdie", else the hottest
/// CPU chip sensor, else the hottest sensor.
pub fn pick_cpu(sensors: &[Sensor]) -> Option<f64> {
    let valid = || sensors.iter().filter(|s| s.celsius.is_finite());
    let exact = |chip: &str, labels: &[&str]| {
        valid()
            .find(|s| s.chip == chip && labels.contains(&s.label.as_str()))
            .map(|s| s.celsius)
    };
    let hottest = |pred: &dyn Fn(&Sensor) -> bool| {
        valid()
            .filter(|s| pred(s))
            .map(|s| s.celsius)
            .reduce(f64::max)
    };
    exact("coretemp", &["Package id 0"])
        .or_else(|| exact("k10temp", &["Tctl", "Tdie"]))
        .or_else(|| hottest(&|s| CPU_CHIPS.contains(&s.chip.as_str())))
        .or_else(|| hottest(&|_| true))
}

impl TempReport {
    pub fn host_temp(&self) -> Option<HostTemp> {
        pick_cpu(&self.sensors).map(|celsius| HostTemp {
            node: self.node.clone(),
            celsius,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(chip: &str, label: &str, celsius: f64) -> Sensor {
        Sensor {
            chip: chip.into(),
            label: label.into(),
            celsius,
        }
    }

    #[test]
    fn intel_package() {
        let v = [
            s("nvme", "Composite", 70.0),
            s("coretemp", "Core 0", 60.0),
            s("coretemp", "Package id 0", 55.0),
        ];
        assert_eq!(pick_cpu(&v), Some(55.0));
    }

    #[test]
    fn amd_tctl() {
        let v = [s("k10temp", "Tccd1", 66.0), s("k10temp", "Tctl", 62.5)];
        assert_eq!(pick_cpu(&v), Some(62.5));
    }

    #[test]
    fn hottest_cpu_chip_then_anything() {
        let v = [
            s("zenpower", "Tccd1", 50.0),
            s("zenpower", "Tccd2", 58.0),
            s("nvme", "x", 80.0),
        ];
        assert_eq!(pick_cpu(&v), Some(58.0));
        assert_eq!(
            pick_cpu(&[s("acpitz", "temp1", 40.0), s("nvme", "x", 45.0)]),
            Some(45.0)
        );
        assert_eq!(pick_cpu(&[]), None);
        assert_eq!(pick_cpu(&[s("x", "y", f64::NAN)]), None);
    }

    #[test]
    fn parses_the_agent_reply() {
        let r = parse(
            br#"{"schema":1,"node":"pve","sensors":[{"chip":"coretemp","label":"Package id 0","celsius":54.0}]}"#,
        )
        .unwrap();
        assert_eq!(
            r.host_temp(),
            Some(HostTemp {
                node: "pve".into(),
                celsius: 54.0
            })
        );
        assert!(
            parse(br#"{"schema":2,"node":"pve","sensors":[]}"#)
                .unwrap_err()
                .contains("schema 2")
        );
        assert!(parse(b"nope").is_err());
    }
}
