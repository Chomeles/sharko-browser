//! Web Storage backing.
//!
//! * `sessionStorage` lives in a process-wide map keyed by origin. A renderer process
//!   serves one tab, so this matches the per-tab lifetime (it survives navigations).
//! * `localStorage` is persisted per origin as a JSON object in
//!   `<profile_dir>/localstorage/<origin>.json`. Writes are buffered (write-behind) and
//!   flushed on `page_hide`, on drop and periodically. Flushing re-reads the file and
//!   replays our journal of changes on top, so concurrent tabs (other renderer
//!   processes) don't clobber each other's unrelated keys.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

/// Per-origin quota in UTF-16 code units (keys + values), like Chrome's 5M characters.
const QUOTA: usize = 5 * 1024 * 1024;

type Area = BTreeMap<String, String>;

fn session_areas() -> &'static Mutex<HashMap<String, Area>> {
    static S: OnceLock<Mutex<HashMap<String, Area>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug)]
pub(crate) enum StorageError {
    Quota,
    Security(&'static str),
}

enum Op {
    Set(String, String),
    Remove(String),
    Clear,
}

pub(crate) struct Storage {
    profile_dir: PathBuf,
    /// Storage key (serialized origin); `None` for opaque origins.
    origin: Option<String>,
    local: Option<Area>,
    journal: Vec<Op>,
    dirty_since: Option<Instant>,
    /// localStorage for opaque origins that are allowed to use it (memory only).
    persist: bool,
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(|c| c.len_utf16()).sum()
}

fn area_size(a: &Area) -> usize {
    a.iter().map(|(k, v)| utf16_len(k) + utf16_len(v)).sum()
}

/// Map a document URL to a storage key.
pub(crate) fn storage_origin(url: &url::Url) -> Option<String> {
    match url.origin() {
        url::Origin::Tuple(..) => Some(url.origin().ascii_serialization()),
        url::Origin::Opaque(_) => {
            if url.scheme() == "file" {
                Some("file://".to_string())
            } else {
                None
            }
        }
    }
}

fn file_name_for(origin: &str) -> String {
    let mut s = String::with_capacity(origin.len());
    for c in origin.chars() {
        if c.is_ascii_alphanumeric() || c == '.' || c == '-' {
            s.push(c);
        } else {
            s.push('_');
        }
    }
    s.push_str(".json");
    s
}

fn read_area(path: &Path) -> Area {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice::<Area>(&bytes).unwrap_or_default(),
        Err(_) => Area::new(),
    }
}

impl Storage {
    pub(crate) fn new(profile_dir: PathBuf, url: &url::Url) -> Self {
        let origin = storage_origin(url);
        Storage {
            persist: origin.is_some() && !profile_dir.as_os_str().is_empty(),
            profile_dir,
            origin,
            local: None,
            journal: Vec::new(),
            dirty_since: None,
        }
    }

    /// The document URL changed origin (should not happen within a document, but keep
    /// storage consistent if it does).
    pub(crate) fn set_url(&mut self, url: &url::Url) {
        let origin = storage_origin(url);
        if origin != self.origin {
            self.flush();
            self.origin = origin;
            self.local = None;
            self.persist = self.origin.is_some() && !self.profile_dir.as_os_str().is_empty();
        }
    }

    fn path(&self) -> Option<PathBuf> {
        let origin = self.origin.as_ref()?;
        if !self.persist {
            return None;
        }
        Some(
            self.profile_dir
                .join("localstorage")
                .join(file_name_for(origin)),
        )
    }

    fn local(&mut self) -> Result<&mut Area, StorageError> {
        if self.origin.is_none() {
            return Err(StorageError::Security(
                "Storage is disabled for documents with an opaque origin",
            ));
        }
        if self.local.is_none() {
            let area = self.path().map(|p| read_area(&p)).unwrap_or_default();
            self.local = Some(area);
        }
        Ok(self.local.as_mut().unwrap())
    }

    fn with_session<R>(&self, f: impl FnOnce(&mut Area) -> R) -> Result<R, StorageError> {
        let origin = self.origin.as_ref().ok_or(StorageError::Security(
            "Storage is disabled for documents with an opaque origin",
        ))?;
        let mut map = session_areas().lock().unwrap_or_else(|e| e.into_inner());
        Ok(f(map.entry(origin.clone()).or_default()))
    }

    fn touch(&mut self, op: Op) {
        self.journal.push(op);
        if self.dirty_since.is_none() {
            self.dirty_since = Some(Instant::now());
        }
    }

    pub(crate) fn get(&mut self, kind: u32, key: &str) -> Result<Option<String>, StorageError> {
        if kind == 0 {
            Ok(self.local()?.get(key).cloned())
        } else {
            self.with_session(|a| a.get(key).cloned())
        }
    }

    pub(crate) fn set(&mut self, kind: u32, key: &str, value: &str) -> Result<(), StorageError> {
        let fits = |a: &Area| {
            let old = a
                .get(key)
                .map(|v| utf16_len(key) + utf16_len(v))
                .unwrap_or(0);
            area_size(a) - old + utf16_len(key) + utf16_len(value) <= QUOTA
        };
        if kind == 0 {
            let area = self.local()?;
            if area.get(key).is_some_and(|v| v == value) {
                return Ok(());
            }
            if !fits(area) {
                return Err(StorageError::Quota);
            }
            area.insert(key.to_string(), value.to_string());
            self.touch(Op::Set(key.to_string(), value.to_string()));
            Ok(())
        } else {
            self.with_session(|a| {
                if !fits(a) {
                    return Err(StorageError::Quota);
                }
                a.insert(key.to_string(), value.to_string());
                Ok(())
            })?
        }
    }

    pub(crate) fn remove(&mut self, kind: u32, key: &str) -> Result<(), StorageError> {
        if kind == 0 {
            if self.local()?.remove(key).is_some() {
                self.touch(Op::Remove(key.to_string()));
            }
            Ok(())
        } else {
            self.with_session(|a| {
                a.remove(key);
            })
        }
    }

    pub(crate) fn clear(&mut self, kind: u32) -> Result<(), StorageError> {
        if kind == 0 {
            let area = self.local()?;
            if !area.is_empty() {
                area.clear();
                self.touch(Op::Clear);
            }
            Ok(())
        } else {
            self.with_session(|a| a.clear())
        }
    }

    pub(crate) fn keys(&mut self, kind: u32) -> Result<Vec<String>, StorageError> {
        if kind == 0 {
            Ok(self.local()?.keys().cloned().collect())
        } else {
            self.with_session(|a| a.keys().cloned().collect())
        }
    }

    /// Flush if there are changes older than `max_age`.
    pub(crate) fn maybe_flush(&mut self, max_age: std::time::Duration) {
        if self.dirty_since.is_some_and(|t| t.elapsed() >= max_age) {
            self.flush();
        }
    }

    pub(crate) fn has_pending_writes(&self) -> bool {
        self.dirty_since.is_some()
    }

    /// Write buffered localStorage changes to disk (merge with the current file).
    pub(crate) fn flush(&mut self) {
        if self.journal.is_empty() {
            self.dirty_since = None;
            return;
        }
        let journal = std::mem::take(&mut self.journal);
        self.dirty_since = None;
        let Some(path) = self.path() else {
            return;
        };
        let mut on_disk = read_area(&path);
        for op in journal {
            match op {
                Op::Set(k, v) => {
                    on_disk.insert(k, v);
                }
                Op::Remove(k) => {
                    on_disk.remove(&k);
                }
                Op::Clear => on_disk.clear(),
            }
        }
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let tmp = path.with_extension(format!("json.tmp{}", std::process::id()));
        if let Ok(json) = serde_json::to_vec(&on_disk) {
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            } else {
                let _ = std::fs::remove_file(&tmp);
            }
        }
        // Adopt the merged view (includes other tabs' writes).
        self.local = Some(on_disk);
    }
}

impl Drop for Storage {
    fn drop(&mut self) {
        self.flush();
    }
}
