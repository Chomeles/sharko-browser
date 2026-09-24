//! Script watchdog: terminates a single entry into JS that runs longer than the limit.
//!
//! One background thread per runtime waits on a condition variable. Entering JS arms a
//! deadline; leaving disarms it. If the deadline passes while armed, the thread calls
//! `IsolateHandle::terminate_execution` (thread-safe) and records that it fired; the
//! runtime then cancels the termination on exit and reports "script timeout".

use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

struct WdState {
    deadline: Option<Instant>,
    generation: u64,
    fired: bool,
    shutdown: bool,
}

pub(crate) struct Watchdog {
    shared: Arc<(Mutex<WdState>, Condvar)>,
    thread: Option<JoinHandle<()>>,
}

impl Watchdog {
    pub(crate) fn new(handle: v8::IsolateHandle) -> Self {
        let shared = Arc::new((
            Mutex::new(WdState {
                deadline: None,
                generation: 0,
                fired: false,
                shutdown: false,
            }),
            Condvar::new(),
        ));
        let s2 = shared.clone();
        let thread = std::thread::Builder::new()
            .name("js-watchdog".into())
            .spawn(move || {
                let (lock, cv) = &*s2;
                let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
                loop {
                    if st.shutdown {
                        return;
                    }
                    match st.deadline {
                        None => {
                            st = cv.wait(st).unwrap_or_else(|e| e.into_inner());
                        }
                        Some(deadline) => {
                            let now = Instant::now();
                            if now >= deadline {
                                st.deadline = None;
                                st.fired = true;
                                handle.terminate_execution();
                            } else {
                                st = cv
                                    .wait_timeout(st, deadline - now)
                                    .unwrap_or_else(|e| e.into_inner())
                                    .0;
                            }
                        }
                    }
                }
            })
            .ok();
        Watchdog { shared, thread }
    }

    /// Arm the watchdog for one entry.
    pub(crate) fn arm(&self, limit: Duration) {
        let (lock, cv) = &*self.shared;
        let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
        st.generation += 1;
        st.fired = false;
        st.deadline = Some(Instant::now() + limit);
        cv.notify_one();
    }

    /// Disarm; returns true if the watchdog terminated execution during this entry.
    pub(crate) fn disarm(&self) -> bool {
        let (lock, _cv) = &*self.shared;
        let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
        st.deadline = None;
        std::mem::take(&mut st.fired)
    }
}

impl Drop for Watchdog {
    fn drop(&mut self) {
        {
            let (lock, cv) = &*self.shared;
            let mut st = lock.lock().unwrap_or_else(|e| e.into_inner());
            st.shutdown = true;
            cv.notify_one();
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}
