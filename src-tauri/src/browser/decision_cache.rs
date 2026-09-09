//! Bounded second-chance CLOCK cache. Original implementation; cache concepts
//! surveyed at https://github.com/cacheMon/libCacheSim (no vendored code).
//! Full keys are compared: a hash collision must never change a blocking rule.
use std::{collections::HashMap, hash::Hash};

pub(crate) struct ClockCache<K, V> {
    slots: Vec<(K, V, bool)>,
    positions: HashMap<K, usize>,
    hand: usize,
    capacity: usize,
}
impl<K: Eq + Hash + Clone, V: Copy> ClockCache<K, V> {
    pub fn new(capacity: usize) -> Self {
        Self {
            slots: Vec::new(),
            positions: HashMap::new(),
            hand: 0,
            capacity,
        }
    }
    pub fn get(&mut self, key: &K) -> Option<V> {
        let i = *self.positions.get(key)?;
        self.slots[i].2 = true;
        Some(self.slots[i].1)
    }
    pub fn insert(&mut self, key: K, value: V) {
        if self.capacity == 0 {
            return;
        }
        if let Some(&i) = self.positions.get(&key) {
            self.slots[i].1 = value;
            self.slots[i].2 = true;
            return;
        }
        if self.slots.len() < self.capacity {
            self.positions.insert(key.clone(), self.slots.len());
            self.slots.push((key, value, false));
            return;
        }
        while self.slots[self.hand].2 {
            self.slots[self.hand].2 = false;
            self.hand = (self.hand + 1) % self.capacity;
        }
        self.positions.remove(&self.slots[self.hand].0);
        self.positions.insert(key.clone(), self.hand);
        self.slots[self.hand] = (key, value, false);
        self.hand = (self.hand + 1) % self.capacity;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clock_retains_reused_keys_and_is_bounded() {
        let mut c = ClockCache::new(3);
        c.insert("a", true);
        c.insert("b", false);
        c.insert("c", false);
        assert_eq!(c.get(&"a"), Some(true));
        c.insert("d", true);
        assert_eq!(c.get(&"b"), None);
        assert_eq!(c.get(&"a"), Some(true));
        for _ in 0..100 {
            c.insert("a", false);
        }
        assert_eq!(c.slots.len(), 3);
        assert_eq!(c.get(&"a"), Some(false));
    }
    #[test]
    fn zero_capacity_does_not_retain_keys() {
        let mut c = ClockCache::new(0);
        c.insert(1, false);
        assert_eq!(c.get(&1), None);
    }
}
