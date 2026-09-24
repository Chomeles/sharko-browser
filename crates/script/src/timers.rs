//! Native one-shot timers (`N.setTimer` / `N.clearTimer`). Intervals are re-armed by JS.

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant};

/// Timer heap ordered by (deadline, insertion sequence) so equal deadlines fire in
/// registration order.
#[derive(Default)]
pub(crate) struct Timers {
    queue: BTreeMap<(Instant, u64), f64>,
    by_id: HashMap<u64, (Instant, u64)>,
    seq: u64,
}

fn key(id: f64) -> u64 {
    // Normalize -0 to 0 so both address the same timer.
    if id == 0.0 { 0 } else { id.to_bits() }
}

impl Timers {
    /// Schedule (or reschedule) timer `id` to fire after `delay_ms`.
    pub(crate) fn set(&mut self, id: f64, delay_ms: f64, now: Instant) {
        self.clear(id);
        let delay = if delay_ms.is_finite() && delay_ms > 0.0 {
            // HTML clamps to a signed 32-bit millisecond range.
            delay_ms.min(i32::MAX as f64)
        } else {
            0.0
        };
        let deadline = now + Duration::from_micros((delay * 1000.0) as u64);
        self.seq += 1;
        let k = (deadline, self.seq);
        self.queue.insert(k, id);
        self.by_id.insert(key(id), k);
    }

    pub(crate) fn clear(&mut self, id: f64) {
        if let Some(k) = self.by_id.remove(&key(id)) {
            self.queue.remove(&k);
        }
    }

    pub(crate) fn next_deadline(&self) -> Option<Instant> {
        self.queue.keys().next().map(|(d, _)| *d)
    }

    /// Remove and return all timers due at `now`, in firing order.
    pub(crate) fn take_due(&mut self, now: Instant) -> Vec<f64> {
        let mut due = Vec::new();
        while let Some((&(deadline, seq), &id)) = self.queue.iter().next() {
            if deadline > now {
                break;
            }
            self.queue.remove(&(deadline, seq));
            self.by_id.remove(&key(id));
            due.push(id);
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering_and_cancel() {
        let mut t = Timers::default();
        let now = Instant::now();
        t.set(1.0, 10.0, now);
        t.set(2.0, 0.0, now);
        t.set(3.0, 0.0, now);
        t.set(4.0, 5.0, now);
        t.clear(3.0);
        assert_eq!(t.take_due(now), vec![2.0]);
        assert_eq!(t.take_due(now + Duration::from_millis(20)), vec![4.0, 1.0]);
        assert_eq!(t.next_deadline(), None);
        t.set(5.0, f64::NAN, now);
        t.set(5.0, 1.0, now); // re-arm replaces
        assert_eq!(t.take_due(now), Vec::<f64>::new());
        assert_eq!(t.next_deadline(), Some(now + Duration::from_millis(1)));
    }
}
