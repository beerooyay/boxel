//! The ledger: one exact integer per 16 × 16 block of an unbounded plane.
//!
//! A block's entry is the sum, over live events, of the most each one will ever put on the
//! block's nearest cell to it. Every term is rounded up into units of 2⁻⁴⁰ when it is added
//! and the same integer is subtracted when it is removed, so the ledger never drifts, two
//! machines agree on it bit for bit, and a block every event has left reads exactly zero
//! and can be forgotten. Only blocks some event can reach have an entry, so the map grows
//! with what is happening, not with the size of the world.

use alloc::vec;
use alloc::vec::Vec;

/// Ledger units per unit of field value.
pub const UNIT: f64 = (1u64 << 40) as f64;

/// No page: the block is outside the window and reads as zero.
pub const NONE: u32 = u32::MAX;

const EMPTY: u64 = u64::MAX;

#[derive(Clone, Copy)]
pub struct Entry {
    key: u64,
    pub ledger: u64,
    pub page: u32,
}

/// Open addressing with linear probing and backward-shift deletion, so there are no
/// tombstones and probe chains stay short however long the world runs. The hash is a fixed
/// Fibonacci multiply: no per-process seed, so layout and iteration are reproducible.
pub struct Blocks {
    slots: Vec<Entry>,
    len: usize,
    shift: u32,
}

/// Block coordinates packed into one word. Cells are `i32`, so blocks fit in 28 bits each
/// and the bias keeps every real key away from `EMPTY`.
#[inline]
pub fn key(bx: i32, by: i32) -> u64 {
    ((bx as i64 + (1 << 31)) as u64) << 32 | (by as i64 + (1 << 31)) as u64
}

impl Blocks {
    pub fn new() -> Blocks {
        Blocks { slots: vec![Entry { key: EMPTY, ledger: 0, page: NONE }; 64], len: 0, shift: 64 - 6 }
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.len
    }

    pub fn bytes(&self) -> usize {
        self.slots.len() * core::mem::size_of::<Entry>()
    }

    #[inline]
    fn home(&self, key: u64) -> usize {
        (key.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> self.shift) as usize
    }

    #[inline]
    pub fn find(&self, key: u64) -> Option<usize> {
        let mask = self.slots.len() - 1;
        let mut i = self.home(key);
        loop {
            let k = self.slots[i].key;
            if k == key {
                return Some(i);
            }
            if k == EMPTY {
                return None;
            }
            i = (i + 1) & mask;
        }
    }

    /// The slot for `key`, inserting a zero entry if there is none. Slot numbers are only good
    /// until the next insertion or removal.
    pub fn slot(&mut self, key: u64) -> usize {
        if let Some(i) = self.find(key) {
            return i;
        }
        if 2 * (self.len + 1) > self.slots.len() {
            self.grow();
        }
        let mask = self.slots.len() - 1;
        let mut i = self.home(key);
        while self.slots[i].key != EMPTY {
            i = (i + 1) & mask;
        }
        self.slots[i] = Entry { key, ledger: 0, page: NONE };
        self.len += 1;
        i
    }

    #[inline]
    pub fn get(&self, slot: usize) -> &Entry {
        &self.slots[slot]
    }

    #[inline]
    pub fn get_mut(&mut self, slot: usize) -> &mut Entry {
        &mut self.slots[slot]
    }

    /// Page of the block, or `NONE`.
    #[inline]
    pub fn page(&self, key: u64) -> u32 {
        self.find(key).map_or(NONE, |i| self.slots[i].page)
    }

    pub fn remove(&mut self, slot: usize) {
        let mask = self.slots.len() - 1;
        let mut hole = slot;
        let mut i = (slot + 1) & mask;
        loop {
            let k = self.slots[i].key;
            if k == EMPTY {
                break;
            }
            // an entry may fill the hole only if the hole lies on its probe path
            let home = self.home(k);
            if (i.wrapping_sub(home) & mask) >= (i.wrapping_sub(hole) & mask) {
                self.slots[hole] = self.slots[i];
                hole = i;
            }
            i = (i + 1) & mask;
        }
        self.slots[hole].key = EMPTY;
        self.len -= 1;
    }

    fn grow(&mut self) {
        let old = core::mem::replace(&mut self.slots, vec![Entry { key: EMPTY, ledger: 0, page: NONE }; 0]);
        self.slots = vec![Entry { key: EMPTY, ledger: 0, page: NONE }; old.len() * 2];
        self.shift -= 1;
        let mask = self.slots.len() - 1;
        for e in old.into_iter().filter(|e| e.key != EMPTY) {
            let mut i = self.home(e.key);
            while self.slots[i].key != EMPTY {
                i = (i + 1) & mask;
            }
            self.slots[i] = e;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn insert_find_remove_under_churn() {
        let mut m = Blocks::new();
        let mut live = std::collections::HashMap::new();
        let mut seed = 7u64;
        for step in 0..200_000u64 {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            let (bx, by) = (((seed >> 33) % 64) as i32 - 32, ((seed >> 45) % 64) as i32 - 32);
            let k = key(bx, by);
            if live.contains_key(&k) && step % 3 == 0 {
                let s = m.find(k).unwrap();
                m.remove(s);
                live.remove(&k);
            } else {
                let s = m.slot(k);
                m.get_mut(s).ledger = step;
                live.insert(k, step);
            }
        }
        assert_eq!(m.len(), live.len());
        for (&k, &v) in &live {
            assert_eq!(m.get(m.find(k).unwrap()).ledger, v);
        }
        assert!(m.find(key(-1, -1)).is_none() || live.contains_key(&key(-1, -1)));
    }
}
