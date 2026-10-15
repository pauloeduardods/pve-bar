// SPDX-License-Identifier: GPL-3.0-or-later
//! How long pved waits before the next poll.

use std::time::Duration;

/// `pvestatd` refreshes the numbers every 10 s; polling faster only costs CPU.
pub const NORMAL: Duration = Duration::from_secs(10);
pub const MAX: Duration = Duration::from_secs(120);
/// While the screen is locked nobody sees the panel.
pub const LOCKED: Duration = Duration::from_secs(60);

#[derive(Debug, Clone)]
pub struct Schedule {
    base: Duration,
    failures: u32,
}

impl Schedule {
    pub fn new(base: Duration) -> Self {
        Self { base, failures: 0 }
    }

    pub fn success(&mut self) {
        self.failures = 0;
    }

    pub fn failure(&mut self) {
        self.failures = self.failures.saturating_add(1);
    }

    pub fn failures(&self) -> u32 {
        self.failures
    }

    /// base, then base × 2, 4, 8 ... up to [`MAX`] after failures; never
    /// below [`LOCKED`] while the screen is locked.
    pub fn delay(&self, locked: bool) -> Duration {
        let factor = 1u32 << self.failures.min(5);
        let max = MAX.max(self.base);
        let d = self.base.saturating_mul(factor).min(max);
        if locked { d.max(LOCKED) } else { d }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubles_up_to_two_minutes_and_resets() {
        let mut s = Schedule::new(NORMAL);
        let mut seen = vec![s.delay(false).as_secs()];
        for _ in 0..6 {
            s.failure();
            seen.push(s.delay(false).as_secs());
        }
        assert_eq!(seen, [10, 20, 40, 80, 120, 120, 120]);
        s.success();
        assert_eq!(s.delay(false), NORMAL);
    }

    #[test]
    fn locked_is_at_least_a_minute() {
        let mut s = Schedule::new(NORMAL);
        assert_eq!(s.delay(true), LOCKED);
        for _ in 0..4 {
            s.failure();
        }
        assert_eq!(s.delay(true), Duration::from_secs(120));
    }

    #[test]
    fn many_failures_do_not_overflow() {
        let mut s = Schedule::new(NORMAL);
        for _ in 0..10_000 {
            s.failure();
        }
        assert_eq!(s.delay(false), MAX);
    }
}
