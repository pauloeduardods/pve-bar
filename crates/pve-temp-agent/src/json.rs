// SPDX-License-Identifier: GPL-3.0-or-later
//! The `/temps` reply, written by hand (no dependencies).

use std::fmt::Write;

use crate::hwmon::Sensor;

pub const SCHEMA: u32 = 1;

/// Appends `s` as a JSON string literal, quotes included.
pub fn push_string(out: &mut String, s: &str) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 || c == '\u{7f}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `{"schema":1,"node":"pve","sensors":[{"chip":..,"label":..,"celsius":54.0}]}`
pub fn render(node: &str, sensors: &[Sensor]) -> String {
    let mut out = String::with_capacity(64 + sensors.len() * 64);
    let _ = write!(out, "{{\"schema\":{SCHEMA},\"node\":");
    push_string(&mut out, node);
    out.push_str(",\"sensors\":[");
    for (i, sensor) in sensors.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"chip\":");
        push_string(&mut out, &sensor.chip);
        out.push_str(",\"label\":");
        push_string(&mut out, &sensor.label);
        // Values come from integer millidegrees, so they are always finite;
        // Debug keeps the ".0" and never uses an exponent in this range.
        let celsius = if sensor.celsius.is_finite() {
            sensor.celsius
        } else {
            0.0
        };
        let _ = write!(out, ",\"celsius\":{celsius:?}}}");
    }
    out.push_str("]}");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn esc(s: &str) -> String {
        let mut out = String::new();
        push_string(&mut out, s);
        out
    }

    #[test]
    fn escapes_strings() {
        assert_eq!(esc("plain"), r#""plain""#);
        assert_eq!(esc(r#"a"b\c"#), r#""a\"b\\c""#);
        assert_eq!(esc("l1\nl2\r\t"), r#""l1\nl2\r\t""#);
        assert_eq!(esc("\u{0}\u{1b}\u{7f}"), r#""\u0000\u001b\u007f""#);
        assert_eq!(esc("Tctl °C ✓"), "\"Tctl °C ✓\"");
        assert_eq!(esc("</script>"), r#""</script>""#);
    }

    #[test]
    fn renders_reply() {
        let sensors = [
            Sensor {
                chip: "coretemp".into(),
                label: "Package id 0".into(),
                celsius: 54.0,
            },
            Sensor {
                chip: "nvme".into(),
                label: "Com\"posite".into(),
                celsius: 41.9,
            },
            Sensor {
                chip: "x".into(),
                label: "cold".into(),
                celsius: -0.001,
            },
        ];
        assert_eq!(
            render("pve", &sensors),
            r#"{"schema":1,"node":"pve","sensors":[{"chip":"coretemp","label":"Package id 0","celsius":54.0},{"chip":"nvme","label":"Com\"posite","celsius":41.9},{"chip":"x","label":"cold","celsius":-0.001}]}"#
        );
        assert_eq!(
            render("a\nb", &[]),
            r#"{"schema":1,"node":"a\nb","sensors":[]}"#
        );
    }
}
