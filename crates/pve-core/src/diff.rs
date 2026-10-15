// SPDX-License-Identifier: GPL-3.0-or-later
//! The value map published on D-Bus, and what changed between two cycles.

use std::collections::BTreeMap;

/// `node/pve/cpu` → 23.4, already rounded to display resolution.
pub type Values = BTreeMap<String, f64>;

/// Rounds to a multiple of `step` (0.1, 1, ...). Non-finite stays as is.
pub fn round_to(value: f64, step: f64) -> f64 {
    if !value.is_finite() {
        return value;
    }
    let r = (value / step).round() * step;
    // Clean float noise such as 23.400000000000002 so equal values compare equal.
    if step < 1.0 {
        let digits = (-step.log10()).ceil() as i32;
        let scale = 10f64.powi(digits);
        (r * scale).round() / scale
    } else {
        r
    }
}

/// The changes from `old` to `new`: new or different values, plus every key
/// that disappeared, as `NaN`. Both maps are sorted, so this is one merge
/// pass with no allocation beyond the result.
pub fn diff(old: &Values, new: &Values) -> Vec<(String, f64)> {
    let mut out = Vec::new();
    let mut a = old.iter().peekable();
    let mut b = new.iter().peekable();
    loop {
        match (a.peek(), b.peek()) {
            (None, None) => break,
            (Some((k, _)), None) => {
                out.push(((*k).clone(), f64::NAN));
                a.next();
            }
            (None, Some((k, v))) => {
                out.push(((*k).clone(), **v));
                b.next();
            }
            (Some((ka, va)), Some((kb, vb))) => match ka.cmp(kb) {
                std::cmp::Ordering::Less => {
                    out.push(((*ka).clone(), f64::NAN));
                    a.next();
                }
                std::cmp::Ordering::Greater => {
                    out.push(((*kb).clone(), **vb));
                    b.next();
                }
                std::cmp::Ordering::Equal => {
                    if !same(**va, **vb) {
                        out.push(((*kb).clone(), **vb));
                    }
                    a.next();
                    b.next();
                }
            },
        }
    }
    out
}

fn same(a: f64, b: f64) -> bool {
    a == b || (a.is_nan() && b.is_nan())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, f64)]) -> Values {
        pairs.iter().map(|(k, v)| ((*k).to_owned(), *v)).collect()
    }

    #[test]
    fn rounding() {
        assert_eq!(round_to(23.449, 0.1), 23.4);
        assert_eq!(round_to(23.46, 0.1), 23.5);
        assert_eq!(round_to(0.1 + 0.2, 0.1), 0.3);
        assert_eq!(round_to(61.5, 1.0), 62.0);
        let tenth_gib = 107_374_182.4;
        assert_eq!(
            round_to(1.04 * tenth_gib * 10.0, tenth_gib),
            tenth_gib * 10.0
        );
        assert!(round_to(f64::NAN, 1.0).is_nan());
    }

    #[test]
    fn nothing_changed() {
        let m = map(&[("a", 1.0), ("b", 2.0)]);
        assert!(diff(&m, &m.clone()).is_empty());
    }

    #[test]
    fn changed_added_and_removed() {
        let old = map(&[("a", 1.0), ("b", 2.0), ("d", 4.0)]);
        let new = map(&[("a", 1.0), ("b", 2.5), ("c", 3.0)]);
        let d = diff(&old, &new);
        assert_eq!(d.len(), 3);
        assert_eq!(d[0], ("b".to_owned(), 2.5));
        assert_eq!(d[1], ("c".to_owned(), 3.0));
        assert_eq!(d[2].0, "d");
        assert!(d[2].1.is_nan());
    }

    #[test]
    fn from_empty_sends_everything() {
        let new = map(&[("a", 1.0), ("b", 2.0)]);
        assert_eq!(diff(&Values::new(), &new).len(), 2);
    }
}
