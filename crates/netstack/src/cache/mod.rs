//! HTTP cache for a single user (a "private cache" in RFC 9111 terms).
//!
//! * **Semantics** live in [`policy`]: storability, freshness, validators, 304 merging.
//!   The fetch layer (`fetch.rs`) applies them together with the Fetch spec cache modes.
//! * **Keys.** The *primary key* is `xxh3-128("GET " + URL without fragment +
//!   credentials flag)`. Responses with `Vary` are stored under a *variant key* that also
//!   hashes the request's values of the varied headers, so several variants of one URL
//!   can coexist (e.g. `Vary: Origin`). The latest `Vary` header names per primary key
//!   decide which request headers are hashed at lookup time; the stored request values
//!   are compared again on a hit. `Vary: *` is never stored.
//! * **Tiers.** A bounded in-memory LRU (default 64 MiB, entries up to 1/8 of it) in
//!   front of a bounded on-disk LRU (default 512 MiB, entries up to 1/8 of it). Stores
//!   go to both tiers (disk writes happen on a dedicated writer thread), disk hits are
//!   promoted to memory. Disk reads run on tokio's blocking pool, never on a worker.
//! * **Invalidation.** Unsafe requests invalidate all variants of the URL (RFC 9111 4.4).

pub(crate) mod disk;
pub(crate) mod policy;

use bytes::Bytes;
use http::HeaderMap;
use parking_lot::Mutex;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use url::{Position, Url};
use xxhash_rust::xxh3::Xxh3;

use disk::{DiskStore, IndexRecord, IndexSnapshot};

/// A cached response. Bodies are decoded (no `Content-Encoding`).
#[derive(Debug, Clone)]
pub(crate) struct StoredResponse {
    /// URL without fragment.
    pub url: String,
    pub status: u16,
    pub http_version: &'static str,
    pub headers: Vec<(String, String)>,
    /// Values of the varied request headers when the response was stored.
    pub vary: Vec<(String, Option<String>)>,
    pub request_time: SystemTime,
    pub response_time: SystemTime,
    pub body: Bytes,
}

impl StoredResponse {
    fn weight(&self) -> u64 {
        let headers: usize = self.headers.iter().map(|(k, v)| k.len() + v.len() + 32).sum();
        (self.body.len() + headers + self.url.len() + 256) as u64
    }
}

/// Primary cache key: URL without fragment + credentials mode.
pub(crate) fn primary_key(url: &Url, credentials: bool) -> u128 {
    let mut h = Xxh3::new();
    h.update(b"GET ");
    h.update(url[..Position::AfterQuery].as_bytes());
    h.update(&[u8::from(credentials)]);
    h.digest128()
}

/// The request's values of the varied headers (repeated fields joined with ", ").
fn vary_values(names: &[String], request: &HeaderMap) -> Vec<(String, Option<String>)> {
    names
        .iter()
        .map(|name| {
            let mut joined: Option<String> = None;
            for v in request.get_all(name.as_str()) {
                let v = String::from_utf8_lossy(v.as_bytes());
                match &mut joined {
                    Some(s) => {
                        s.push_str(", ");
                        s.push_str(v.trim());
                    }
                    None => joined = Some(v.trim().to_owned()),
                }
            }
            (name.clone(), joined)
        })
        .collect()
}

fn variant_key(primary: u128, vary: &[(String, Option<String>)]) -> u128 {
    if vary.is_empty() {
        return primary;
    }
    let mut h = Xxh3::new();
    h.update(&primary.to_le_bytes());
    for (name, value) in vary {
        h.update(name.as_bytes());
        match value {
            Some(v) => {
                h.update(&[0, 1]);
                h.update(v.as_bytes());
            }
            None => h.update(&[0, 2]),
        }
        h.update(&[0]);
    }
    h.digest128()
}

#[derive(Clone, Copy, Debug)]
struct Limits {
    mem_budget: u64,
    mem_entry_max: u64,
    disk_budget: u64,
    disk_entry_max: u64,
}

struct MemSlot {
    value: Arc<StoredResponse>,
    weight: u64,
    seq: u64,
}

struct DiskSlot {
    generation: u32,
    size: u64,
    seq: u64,
}

struct Entry {
    primary: u128,
    mem: Option<MemSlot>,
    disk: Option<DiskSlot>,
    /// Generation of a disk write that has been issued but not completed.
    pending_write: Option<u32>,
    /// The value being written, so the entry stays readable until the write commits
    /// even when it is not (or no longer) in the memory tier.
    pending_value: Option<Arc<StoredResponse>>,
}

#[derive(Default)]
struct Primary {
    /// Vary header names of the most recently stored response.
    vary: Vec<String>,
    variants: Vec<u128>,
}

#[derive(Default)]
struct Index {
    entries: HashMap<u128, Entry>,
    primaries: HashMap<u128, Primary>,
    mem_lru: BTreeMap<u64, u128>,
    disk_lru: BTreeMap<u64, u128>,
    next_seq: u64,
    next_generation: u32,
    mem_bytes: u64,
    disk_bytes: u64,
    /// Disk state changed since the index was last persisted.
    dirty: bool,
}

impl Index {
    fn seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }

    fn generation(&mut self) -> u32 {
        self.next_generation = self.next_generation.wrapping_add(1).max(1);
        self.next_generation
    }

    /// Marks an entry as most recently used in both tiers.
    fn touch(&mut self, vkey: u128) {
        let seq = self.seq();
        let Some(e) = self.entries.get_mut(&vkey) else { return };
        if let Some(m) = &mut e.mem {
            self.mem_lru.remove(&m.seq);
            m.seq = seq;
            self.mem_lru.insert(seq, vkey);
        }
        if let Some(d) = &mut e.disk {
            self.disk_lru.remove(&d.seq);
            d.seq = seq;
            self.disk_lru.insert(seq, vkey);
        }
    }

    /// Removes an entry from both tiers; returns its file (to be deleted), if any.
    fn remove(&mut self, vkey: u128, disk: Option<&DiskStore>) -> Option<PathBuf> {
        let e = self.entries.remove(&vkey)?;
        if let Some(m) = e.mem {
            self.mem_lru.remove(&m.seq);
            self.mem_bytes -= m.weight;
        }
        if let Some(p) = self.primaries.get_mut(&e.primary) {
            p.variants.retain(|v| *v != vkey);
            if p.variants.is_empty() {
                self.primaries.remove(&e.primary);
            }
        }
        let d = e.disk?;
        self.dirty = true;
        self.disk_lru.remove(&d.seq);
        self.disk_bytes -= d.size;
        disk.map(|s| s.entry_path(vkey, d.generation))
    }

    fn drop_mem_copy(&mut self, vkey: u128) {
        if let Some(e) = self.entries.get_mut(&vkey)
            && let Some(m) = e.mem.take()
        {
            self.mem_lru.remove(&m.seq);
            self.mem_bytes -= m.weight;
        }
    }

    fn evict_memory(&mut self, limits: &Limits, disk: Option<&DiskStore>, deletes: &mut Vec<PathBuf>) {
        while self.mem_bytes > limits.mem_budget {
            let Some((seq, vkey)) = self.mem_lru.pop_first() else { break };
            let Some(e) = self.entries.get_mut(&vkey) else { continue };
            match e.mem.take() {
                Some(m) if m.seq == seq => self.mem_bytes -= m.weight,
                other => {
                    e.mem = other;
                    continue;
                }
            }
            let keep = e.disk.is_some() || (disk.is_some() && e.pending_write.is_some());
            if !keep && let Some(p) = self.remove(vkey, disk) {
                deletes.push(p);
            }
        }
    }

    /// Evicts least recently used disk entries down to 90% of the budget.
    fn evict_disk(&mut self, limits: &Limits, disk: &DiskStore, deletes: &mut Vec<PathBuf>) {
        if self.disk_bytes <= limits.disk_budget {
            return;
        }
        let target = limits.disk_budget / 10 * 9;
        while self.disk_bytes > target {
            let Some((seq, vkey)) = self.disk_lru.pop_first() else { break };
            let Some(e) = self.entries.get_mut(&vkey) else { continue };
            match e.disk.take() {
                Some(d) if d.seq == seq => {
                    self.disk_bytes -= d.size;
                    deletes.push(disk.entry_path(vkey, d.generation));
                }
                other => e.disk = other,
            }
            self.dirty = true;
            if e.mem.is_none() && e.disk.is_none() && e.pending_write.is_none() {
                self.remove(vkey, None);
            }
        }
    }

    fn snapshot(&mut self) -> IndexSnapshot {
        self.dirty = false;
        let mut entries = Vec::with_capacity(self.disk_lru.len());
        let mut primaries = HashSet::new();
        for vkey in self.disk_lru.values() {
            if let Some(e) = self.entries.get(vkey)
                && let Some(d) = &e.disk
            {
                entries.push(IndexRecord {
                    vkey: *vkey,
                    primary: e.primary,
                    generation: d.generation,
                    size: d.size,
                });
                primaries.insert(e.primary);
            }
        }
        let vary = primaries
            .into_iter()
            .filter_map(|p| {
                self.primaries
                    .get(&p)
                    .filter(|info| !info.vary.is_empty())
                    .map(|info| (p, info.vary.clone()))
            })
            .collect();
        IndexSnapshot {
            version: 1,
            entries,
            vary,
        }
    }
}

/// The two-tier HTTP cache.
pub(crate) struct HttpCache {
    index: Arc<Mutex<Index>>,
    disk: Option<Arc<DiskStore>>,
    limits: Limits,
}

impl HttpCache {
    /// Opens the cache. With `dir`, the disk tier is loaded from (and kept in) that
    /// directory; without it (or if it cannot be created) the cache is memory-only.
    pub fn open(dir: Option<PathBuf>, memory_budget: u64, disk_budget: u64) -> Self {
        let limits = Limits {
            mem_budget: memory_budget,
            mem_entry_max: memory_budget / 8,
            disk_budget,
            disk_entry_max: disk_budget / 8,
        };
        let disk = dir.and_then(|d| match DiskStore::open(d.clone()) {
            Ok(store) => Some(Arc::new(store)),
            Err(e) => {
                log::warn!("disk cache disabled, cannot use {}: {e}", d.display());
                None
            }
        });
        let mut index = Index::default();
        if let Some(disk) = &disk {
            if let Some(snapshot) = disk.load_index() {
                for rec in snapshot.entries {
                    let seq = index.seq();
                    index.entries.insert(
                        rec.vkey,
                        Entry {
                            primary: rec.primary,
                            mem: None,
                            disk: Some(DiskSlot {
                                generation: rec.generation,
                                size: rec.size,
                                seq,
                            }),
                            pending_write: None,
                            pending_value: None,
                        },
                    );
                    index.disk_lru.insert(seq, rec.vkey);
                    index.disk_bytes += rec.size;
                    index.next_generation = index.next_generation.max(rec.generation);
                    index.primaries.entry(rec.primary).or_default().variants.push(rec.vkey);
                }
                for (primary, vary) in snapshot.vary {
                    if let Some(p) = index.primaries.get_mut(&primary) {
                        p.vary = vary;
                    }
                }
            }
            // Delete files the index doesn't know about (crash leftovers). Queued before
            // any write, so it cannot race with new entries.
            let known: HashSet<(u128, u32)> = index
                .entries
                .iter()
                .filter_map(|(k, e)| e.disk.as_ref().map(|d| (*k, d.generation)))
                .collect();
            disk.cleanup(Box::new(move |vkey, generation| known.contains(&(vkey, generation))));
            let mut deletes = Vec::new();
            index.evict_disk(&limits, disk, &mut deletes);
            disk.delete(deletes);
        }
        Self {
            index: Arc::new(Mutex::new(index)),
            disk,
            limits,
        }
    }

    /// Looks up a stored response for a GET request with the given (final) headers.
    pub async fn lookup(
        &self,
        url: &Url,
        credentials: bool,
        request: &HeaderMap,
    ) -> Option<Arc<StoredResponse>> {
        let primary = primary_key(url, credentials);
        let target = &url[..Position::AfterQuery];
        let (vkey, vary, generation) = {
            let mut idx = self.index.lock();
            let names = idx.primaries.get(&primary)?.vary.clone();
            let vary = vary_values(&names, request);
            let vkey = variant_key(primary, &vary);
            let entry = idx.entries.get(&vkey)?;
            if let Some(value) = entry.mem.as_ref().map(|m| &m.value).or(entry.pending_value.as_ref()) {
                let value = Arc::clone(value);
                idx.touch(vkey);
                return (value.url == target && value.vary == vary).then_some(value);
            }
            let generation = entry.disk.as_ref()?.generation;
            idx.touch(vkey);
            (vkey, vary, generation)
        };
        let disk = self.disk.as_ref()?;
        let path = disk.entry_path(vkey, generation);
        let read = tokio::task::spawn_blocking(move || disk::read_entry(&path)).await;
        match read {
            Ok(Ok(stored)) if stored.url == target && stored.vary == vary => {
                let value = Arc::new(stored);
                self.promote(vkey, generation, &value);
                Some(value)
            }
            Ok(Ok(_)) => None,
            Ok(Err(e)) => {
                log::debug!("dropping unreadable cache entry for {target}: {e}");
                let mut idx = self.index.lock();
                let same = idx
                    .entries
                    .get(&vkey)
                    .and_then(|e| e.disk.as_ref())
                    .is_some_and(|d| d.generation == generation);
                if same {
                    let path = idx.remove(vkey, Some(disk));
                    drop(idx);
                    disk.delete(path.into_iter().collect());
                }
                None
            }
            Err(e) => {
                log::warn!("cache read task failed: {e}");
                None
            }
        }
    }

    /// Adds a copy read from disk to the memory tier.
    fn promote(&self, vkey: u128, generation: u32, value: &Arc<StoredResponse>) {
        let weight = value.weight();
        if weight > self.limits.mem_entry_max {
            return;
        }
        let mut deletes = Vec::new();
        {
            let mut idx = self.index.lock();
            let seq = idx.seq();
            let Some(e) = idx.entries.get_mut(&vkey) else { return };
            if e.mem.is_some() || e.disk.as_ref().is_none_or(|d| d.generation != generation) {
                return;
            }
            e.mem = Some(MemSlot {
                value: Arc::clone(value),
                weight,
                seq,
            });
            idx.mem_lru.insert(seq, vkey);
            idx.mem_bytes += weight;
            idx.evict_memory(&self.limits, self.disk.as_deref(), &mut deletes);
        }
        if let Some(disk) = &self.disk {
            disk.delete(deletes);
        }
    }

    /// Stores (or replaces) a response. `request` are the headers the request was sent
    /// with (for `Vary`), `vary_names` the response's Vary header names.
    pub fn store(
        &self,
        url: &Url,
        credentials: bool,
        request: &HeaderMap,
        vary_names: Vec<String>,
        mut response: StoredResponse,
    ) {
        let primary = primary_key(url, credentials);
        response.url = url[..Position::AfterQuery].to_owned();
        response.vary = vary_values(&vary_names, request);
        let vkey = variant_key(primary, &response.vary);
        let value = Arc::new(response);
        let weight = value.weight();
        let body_len = value.body.len() as u64;
        let disk = self.disk.as_deref();
        let mut deletes = Vec::new();
        let mut write = None;
        {
            let mut idx = self.index.lock();
            let p = idx.primaries.entry(primary).or_default();
            p.vary = vary_names;
            if !p.variants.contains(&vkey) {
                p.variants.push(vkey);
            }
            idx.drop_mem_copy(vkey);
            let seq = idx.seq();
            let generation = idx.generation();
            let entry = idx.entries.entry(vkey).or_insert_with(|| Entry {
                primary,
                mem: None,
                disk: None,
                pending_write: None,
                pending_value: None,
            });
            let in_memory = weight <= self.limits.mem_entry_max;
            if in_memory {
                entry.mem = Some(MemSlot {
                    value: Arc::clone(&value),
                    weight,
                    seq,
                });
            }
            let old_disk = if disk.is_some() && body_len <= self.limits.disk_entry_max {
                entry.pending_write = Some(generation);
                entry.pending_value = Some(Arc::clone(&value));
                write = Some(generation);
                None
            } else {
                // The previous disk version would be outdated: drop it.
                entry.pending_write = None;
                entry.pending_value = None;
                entry.disk.take()
            };
            let orphan = entry.mem.is_none() && entry.disk.is_none() && entry.pending_write.is_none();
            if in_memory {
                idx.mem_lru.insert(seq, vkey);
                idx.mem_bytes += weight;
            }
            if let Some(d) = old_disk {
                idx.disk_lru.remove(&d.seq);
                idx.disk_bytes -= d.size;
                idx.dirty = true;
                if let Some(disk) = disk {
                    deletes.push(disk.entry_path(vkey, d.generation));
                }
            }
            if orphan {
                idx.remove(vkey, disk);
            }
            idx.evict_memory(&self.limits, disk, &mut deletes);
        }
        if let Some(disk) = &self.disk {
            disk.delete(deletes);
            if let Some(generation) = write {
                let index = Arc::clone(&self.index);
                let store = Arc::clone(disk);
                let limits = self.limits;
                disk.write(
                    vkey,
                    generation,
                    value,
                    Box::new(move |result| on_write_done(&index, &store, &limits, vkey, generation, result)),
                );
            }
        }
    }

    /// Removes every stored variant of `url` (both credentials modes).
    pub fn invalidate(&self, url: &Url) {
        let disk = self.disk.as_deref();
        let mut deletes = Vec::new();
        {
            let mut idx = self.index.lock();
            for credentials in [true, false] {
                let primary = primary_key(url, credentials);
                let variants = idx
                    .primaries
                    .get(&primary)
                    .map(|p| p.variants.clone())
                    .unwrap_or_default();
                for vkey in variants {
                    if let Some(path) = idx.remove(vkey, disk) {
                        deletes.push(path);
                    }
                }
            }
        }
        if let Some(disk) = disk {
            disk.delete(deletes);
        }
    }

    /// Whether the persisted index is out of date.
    pub fn is_dirty(&self) -> bool {
        self.disk.is_some() && self.index.lock().dirty
    }

    /// Queues an index snapshot for writing.
    pub fn save_index(&self) {
        if let Some(disk) = &self.disk {
            let snapshot = self.index.lock().snapshot();
            disk.save_index(&snapshot);
        }
    }

    /// Waits for queued disk writes, then persists the index (shutdown path).
    pub fn persist_blocking(&self, timeout: Duration) {
        if let Some(disk) = &self.disk {
            disk.flush(timeout);
            self.save_index();
            disk.flush(timeout);
        }
    }

    #[cfg(test)]
    fn stats(&self) -> (usize, u64, u64) {
        let idx = self.index.lock();
        (idx.entries.len(), idx.mem_bytes, idx.disk_bytes)
    }
}

fn on_write_done(
    index: &Mutex<Index>,
    disk: &DiskStore,
    limits: &Limits,
    vkey: u128,
    generation: u32,
    result: io::Result<u64>,
) {
    let mut deletes = Vec::new();
    {
        let mut idx = index.lock();
        let current = idx
            .entries
            .get(&vkey)
            .is_some_and(|e| e.pending_write == Some(generation));
        match (current, result) {
            (true, Ok(size)) => {
                let seq = idx.seq();
                let old = idx.entries.get_mut(&vkey).and_then(|e| {
                    e.pending_write = None;
                    e.pending_value = None;
                    e.disk.replace(DiskSlot { generation, size, seq })
                });
                if let Some(old) = old {
                    idx.disk_lru.remove(&old.seq);
                    idx.disk_bytes -= old.size;
                    deletes.push(disk.entry_path(vkey, old.generation));
                }
                idx.disk_lru.insert(seq, vkey);
                idx.disk_bytes += size;
                idx.dirty = true;
                idx.evict_disk(limits, disk, &mut deletes);
            }
            (true, Err(_)) => {
                let orphan = idx.entries.get_mut(&vkey).is_some_and(|e| {
                    e.pending_write = None;
                    e.pending_value = None;
                    e.mem.is_none() && e.disk.is_none()
                });
                if orphan {
                    idx.remove(vkey, None);
                }
            }
            // Superseded by a newer write or removed meanwhile: discard the file.
            (false, Ok(_)) => deletes.push(disk.entry_path(vkey, generation)),
            (false, Err(_)) => {}
        }
    }
    // Runs on the writer thread: delete inline.
    for path in deletes {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http::HeaderValue;

    fn resp(body: &'static str) -> StoredResponse {
        StoredResponse {
            url: String::new(),
            status: 200,
            http_version: "HTTP/1.1",
            headers: vec![("cache-control".into(), "max-age=60".into())],
            vary: Vec::new(),
            request_time: SystemTime::now(),
            response_time: SystemTime::now(),
            body: Bytes::from_static(body.as_bytes()),
        }
    }

    fn headers(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for (k, v) in pairs {
            h.append(*k, HeaderValue::from_static(v));
        }
        h
    }

    fn url(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn keys() {
        let a = primary_key(&url("https://a.com/x?y#frag"), true);
        assert_eq!(a, primary_key(&url("https://a.com/x?y"), true));
        assert_ne!(a, primary_key(&url("https://a.com/x?y"), false));
        assert_ne!(a, primary_key(&url("https://a.com/x?z"), true));
        let de = vary_values(&["accept-language".into()], &headers(&[("accept-language", "de")]));
        let en = vary_values(&["accept-language".into()], &headers(&[("accept-language", "en")]));
        let missing = vary_values(&["accept-language".into()], &headers(&[]));
        assert_eq!(variant_key(a, &[]), a);
        assert_ne!(variant_key(a, &de), variant_key(a, &en));
        assert_ne!(variant_key(a, &missing), variant_key(a, &de));
        // Repeated fields are combined.
        let multi = vary_values(&["x".into()], &headers(&[("x", "1"), ("x", " 2 ")]));
        assert_eq!(multi[0].1.as_deref(), Some("1, 2"));
    }

    #[tokio::test]
    async fn memory_hit_vary_variants_and_invalidation() {
        let cache = HttpCache::open(None, 1 << 20, 0);
        let u = url("https://example.com/page");
        let de = headers(&[("accept-language", "de")]);
        let en = headers(&[("accept-language", "en")]);
        cache.store(&u, true, &de, vec!["accept-language".into()], resp("hallo"));
        assert_eq!(&cache.lookup(&u, true, &de).await.unwrap().body[..], b"hallo");
        assert!(cache.lookup(&u, true, &en).await.is_none());
        assert!(cache.lookup(&u, false, &de).await.is_none());
        cache.store(&u, true, &en, vec!["accept-language".into()], resp("hello"));
        assert_eq!(&cache.lookup(&u, true, &en).await.unwrap().body[..], b"hello");
        assert_eq!(&cache.lookup(&u, true, &de).await.unwrap().body[..], b"hallo");
        cache.invalidate(&url("https://example.com/page#x"));
        assert!(cache.lookup(&u, true, &de).await.is_none());
        assert!(cache.lookup(&u, true, &en).await.is_none());
        assert_eq!(cache.stats().0, 0);
    }

    #[tokio::test]
    async fn memory_lru_eviction() {
        let cache = HttpCache::open(None, 3000, 0);
        let h = HeaderMap::new();
        for i in 0..10 {
            cache.store(&url(&format!("https://e.com/{i}")), true, &h, vec![], resp("0123456789"));
        }
        let (entries, mem, _) = cache.stats();
        assert!(mem <= 3000, "{mem}");
        assert!(entries < 10 && entries > 0);
        assert!(cache.lookup(&url("https://e.com/9"), true, &h).await.is_some());
        assert!(cache.lookup(&url("https://e.com/0"), true, &h).await.is_none());
    }

    #[tokio::test]
    async fn disk_persistence_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let u = url("https://example.com/app.js");
        let h = HeaderMap::new();
        {
            let cache = HttpCache::open(Some(dir.path().to_path_buf()), 1 << 20, 1 << 20);
            cache.store(&u, true, &h, vec![], resp("console.log(1)"));
            cache.persist_blocking(Duration::from_secs(5));
            assert!(cache.stats().2 > 0);
        }
        let cache = HttpCache::open(Some(dir.path().to_path_buf()), 1 << 20, 1 << 20);
        assert_eq!(cache.stats().1, 0, "memory tier starts empty");
        let hit = cache.lookup(&u, true, &h).await.unwrap();
        assert_eq!(&hit.body[..], b"console.log(1)");
        assert_eq!(hit.url, "https://example.com/app.js");
        assert!(cache.stats().1 > 0, "disk hit promoted to memory");
    }

    #[tokio::test]
    async fn readable_while_disk_write_is_pending() {
        let dir = tempfile::tempdir().unwrap();
        let h = HeaderMap::new();
        // No memory tier: before the write commits, only the pending value can serve it.
        let cache = HttpCache::open(Some(dir.path().to_path_buf()), 1, 1 << 20);
        let u = url("https://example.com/big.bin");
        cache.store(&u, true, &h, vec![], resp("payload"));
        assert_eq!(&cache.lookup(&u, true, &h).await.unwrap().body[..], b"payload");
        cache.persist_blocking(Duration::from_secs(5));
        assert!(cache.index.lock().entries.values().all(|e| e.pending_value.is_none()));
        assert_eq!(&cache.lookup(&u, true, &h).await.unwrap().body[..], b"payload");
    }

    #[tokio::test]
    async fn disk_lru_eviction_and_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let h = HeaderMap::new();
        // Memory tier too small to hold anything: every hit comes from disk.
        let cache = HttpCache::open(Some(dir.path().to_path_buf()), 1, 4000);
        let big = "x".repeat(300).leak();
        for i in 0..20 {
            cache.store(&url(&format!("https://e.com/{i}")), true, &h, vec![], resp(big));
        }
        cache.persist_blocking(Duration::from_secs(5));
        let (_, _, disk_bytes) = cache.stats();
        assert!(disk_bytes <= 4000, "{disk_bytes}");
        assert!(cache.lookup(&url("https://e.com/19"), true, &h).await.is_some());
        assert!(cache.lookup(&url("https://e.com/0"), true, &h).await.is_none());

        // Corrupt the newest entry on disk: it becomes a miss and is removed.
        let u = url("https://e.com/19");
        let vkey = primary_key(&u, true);
        let generation = {
            let idx = cache.index.lock();
            idx.entries[&vkey].disk.as_ref().unwrap().generation
        };
        let path = cache.disk.as_ref().unwrap().entry_path(vkey, generation);
        std::fs::write(&path, b"garbage").unwrap();
        assert!(cache.lookup(&u, true, &h).await.is_none());
        assert!(!cache.index.lock().entries.contains_key(&vkey));
    }
}
