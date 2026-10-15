// SPDX-License-Identifier: GPL-3.0-or-later
//! A fixed-size history of samples: 360 points is one hour at 10 s. Storage
//! is allocated once; pushing never allocates.

#[derive(Debug, Clone)]
pub struct Ring<const N: usize> {
    data: Box<[f32; N]>,
    /// Index of the next write.
    head: usize,
    len: usize,
}

pub type HourRing = Ring<360>;

impl<const N: usize> Default for Ring<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> Ring<N> {
    pub fn new() -> Self {
        Self {
            data: Box::new([0.0; N]),
            head: 0,
            len: 0,
        }
    }

    pub fn push(&mut self, value: f32) {
        self.data[self.head] = value;
        self.head = (self.head + 1) % N;
        self.len = (self.len + 1).min(N);
    }

    pub fn len(&self) -> usize {
        self.len
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    pub fn last(&self) -> Option<f32> {
        (self.len > 0).then(|| self.data[(self.head + N - 1) % N])
    }

    /// Oldest first.
    pub fn iter(&self) -> impl Iterator<Item = f32> + '_ {
        let start = (self.head + N - self.len) % N;
        (0..self.len).map(move |i| self.data[(start + i) % N])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_newest_n_oldest_first() {
        let mut r = Ring::<3>::new();
        assert!(r.is_empty());
        assert_eq!(r.last(), None);
        r.push(1.0);
        r.push(2.0);
        assert_eq!(r.iter().collect::<Vec<_>>(), [1.0, 2.0]);
        r.push(3.0);
        r.push(4.0);
        assert_eq!(r.iter().collect::<Vec<_>>(), [2.0, 3.0, 4.0]);
        assert_eq!(r.len(), 3);
        assert_eq!(r.last(), Some(4.0));
    }

    #[test]
    fn hour_ring_is_360_points() {
        let mut r = HourRing::new();
        for i in 0..1000 {
            r.push(i as f32);
        }
        assert_eq!(r.len(), 360);
        assert_eq!(r.iter().next(), Some(640.0));
    }
}
