// SPDX-License-Identifier: GPL-3.0-or-later
//! A fixed-size history of samples: 360 points is one hour at 10 s. Storage
//! is allocated once; pushing never allocates. f32 by default (values are
//! rounded to display resolution anyway, so f32 halves the memory for free);
//! pved keeps each server's poll times in an f64 ring next to its value rings.

#[derive(Debug, Clone)]
pub struct Ring<const N: usize, T: Copy + Default = f32> {
    data: Box<[T; N]>,
    /// Index of the next write.
    head: usize,
    len: usize,
}

pub type HourRing = Ring<360>;

impl<const N: usize, T: Copy + Default> Default for Ring<N, T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize, T: Copy + Default> Ring<N, T> {
    pub fn new() -> Self {
        Self {
            data: Box::new([T::default(); N]),
            head: 0,
            len: 0,
        }
    }

    pub fn push(&mut self, value: T) {
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

    pub fn last(&self) -> Option<T> {
        (self.len > 0).then(|| self.data[(self.head + N - 1) % N])
    }

    fn slot(&self, i: usize) -> usize {
        (self.head + N - self.len + i) % N
    }

    /// The `i`-th sample, oldest first.
    pub fn get(&self, i: usize) -> Option<T> {
        (i < self.len).then(|| self.data[self.slot(i)])
    }

    /// Mutable access to the `i`-th sample, oldest first.
    pub fn get_mut(&mut self, i: usize) -> Option<&mut T> {
        if i < self.len {
            let slot = self.slot(i);
            Some(&mut self.data[slot])
        } else {
            None
        }
    }

    /// Oldest first.
    pub fn iter(&self) -> impl Iterator<Item = T> + '_ {
        (0..self.len).map(move |i| self.data[self.slot(i)])
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

    #[test]
    fn indexed_access_is_oldest_first_and_wraps() {
        let mut r = Ring::<3, f64>::new();
        assert_eq!(r.get(0), None);
        for v in [1.0, 2.0, 3.0, 4.0] {
            r.push(v);
        }
        assert_eq!((r.get(0), r.get(2), r.get(3)), (Some(2.0), Some(4.0), None));
        *r.get_mut(1).unwrap() = 30.0;
        assert_eq!(r.iter().collect::<Vec<_>>(), [2.0, 30.0, 4.0]);
        assert!(r.get_mut(3).is_none());
    }
}
