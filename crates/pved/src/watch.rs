// SPDX-License-Identifier: GPL-3.0-or-later
//! Which guests clients watch (`Watch`/`Unwatch`), by caller.
//!
//! Counted per caller and guest, because one client often watches the same
//! guest twice: the extension's bar segment and its open menu share one bus
//! connection, and closing the menu must not stop the segment's details. A
//! guest is watched while any caller has a count above zero; a caller whose
//! bus name vanishes loses all its watches.

use std::collections::{BTreeMap, BTreeSet, HashMap};

/// A client can watch at most this many different guests.
pub const MAX_PER_CALLER: usize = 16;

/// (server, vmid)
pub type GuestId = (String, u32);

#[derive(Debug, Default)]
pub struct Watches {
    by_caller: HashMap<String, BTreeMap<GuestId, u32>>,
}

#[derive(Debug, PartialEq, Eq)]
pub struct TooMany;

impl Watches {
    /// Adds one watch of `guest` by `caller`. Ok(true) when nobody watched
    /// the guest before.
    pub fn watch(&mut self, caller: &str, guest: GuestId) -> Result<bool, TooMany> {
        let first = !self.is_watched(&guest);
        let mine = self.by_caller.entry(caller.to_owned()).or_default();
        if !mine.contains_key(&guest) && mine.len() >= MAX_PER_CALLER {
            return Err(TooMany);
        }
        let count = mine.entry(guest).or_insert(0);
        *count = count.saturating_add(1);
        Ok(first)
    }

    /// Removes one watch; true when nobody watches the guest any more.
    /// Unwatching what was not watched does nothing.
    pub fn unwatch(&mut self, caller: &str, guest: &GuestId) -> bool {
        let Some(mine) = self.by_caller.get_mut(caller) else {
            return false;
        };
        let Some(count) = mine.get_mut(guest) else {
            return false;
        };
        *count -= 1;
        if *count == 0 {
            mine.remove(guest);
            if mine.is_empty() {
                self.by_caller.remove(caller);
            }
            return !self.is_watched(guest);
        }
        false
    }

    /// Drops every watch of a caller that left the bus; true when that
    /// changed the set of watched guests.
    pub fn drop_caller(&mut self, caller: &str) -> bool {
        let Some(mine) = self.by_caller.remove(caller) else {
            return false;
        };
        mine.keys().any(|g| !self.is_watched(g))
    }

    pub fn is_watched(&self, guest: &GuestId) -> bool {
        self.by_caller.values().any(|m| m.contains_key(guest))
    }

    /// The watched vmids of one server.
    pub fn of_server(&self, server: &str) -> BTreeSet<u32> {
        self.by_caller
            .values()
            .flat_map(|m| m.keys())
            .filter(|(s, _)| s == server)
            .map(|(_, vmid)| *vmid)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn g(vmid: u32) -> GuestId {
        ("home".to_owned(), vmid)
    }

    #[test]
    fn counted_per_caller_and_shared_between_callers() {
        let mut w = Watches::default();
        assert_eq!(w.watch(":1.5", g(101)), Ok(true));
        assert_eq!(w.watch(":1.5", g(101)), Ok(false), "same client, twice");
        assert_eq!(w.watch(":1.9", g(101)), Ok(false));
        assert!(!w.unwatch(":1.5", &g(101)));
        assert!(!w.unwatch(":1.5", &g(101)), "still watched by :1.9");
        assert!(!w.unwatch(":1.5", &g(101)), "not watched: nothing happens");
        assert!(w.unwatch(":1.9", &g(101)));
        assert!(w.of_server("home").is_empty());
    }

    #[test]
    fn a_vanished_caller_loses_its_watches() {
        let mut w = Watches::default();
        w.watch(":1.5", g(1)).unwrap();
        w.watch(":1.5", g(2)).unwrap();
        w.watch(":1.6", g(2)).unwrap();
        w.watch(":1.6", ("lab".into(), 7)).unwrap();
        assert_eq!(w.of_server("home"), BTreeSet::from([1, 2]));
        assert!(w.drop_caller(":1.5"), "guest 1 is no longer watched");
        assert_eq!(w.of_server("home"), BTreeSet::from([2]));
        assert!(!w.drop_caller(":1.5"));
        assert_eq!(w.of_server("lab"), BTreeSet::from([7]));
    }

    #[test]
    fn at_most_sixteen_guests_per_caller() {
        let mut w = Watches::default();
        for vmid in 0..16 {
            w.watch(":1.5", g(vmid)).unwrap();
        }
        assert_eq!(w.watch(":1.5", g(16)), Err(TooMany));
        assert_eq!(w.watch(":1.5", g(3)), Ok(false), "again is fine");
        assert_eq!(w.watch(":1.6", g(16)), Ok(true), "others are not affected");
        w.unwatch(":1.5", &g(0));
        assert!(w.watch(":1.5", g(16)).is_ok());
    }
}
