//! On-disk representation of the HTTP cache.
//!
//! Layout under `<profile>/cache/`:
//!
//! ```text
//! index.bin              postcard snapshot of the index (entries in LRU order + Vary names)
//! 3f/3f…(32 hex)-(8 hex)  one file per entry: variant key + write generation
//! ```
//!
//! Entry file: `b"NSC1" | meta_len: u32 LE | meta (postcard) | body`. The body is
//! protected by an xxh3 checksum; corrupt or truncated files are treated as misses.
//!
//! All writes and deletes run on one dedicated writer thread (sequential disk access,
//! no tokio worker is ever blocked); reads run on tokio's blocking pool. Every write goes
//! to a fresh file name (the generation), so a slow write can never clobber a newer one
//! and readers never observe partially written files.

use bytes::Bytes;
use crossbeam_channel::{Receiver, Sender};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use super::StoredResponse;
use crate::util::{from_unix_ms, intern_version, unix_ms, write_atomic};

const MAGIC: &[u8; 4] = b"NSC1";
const INDEX_FILE: &str = "index.bin";
const INDEX_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct EntryMeta {
    url: String,
    status: u16,
    http_version: String,
    headers: Vec<(String, String)>,
    vary: Vec<(String, Option<String>)>,
    request_time_ms: u64,
    response_time_ms: u64,
    body_len: u64,
    body_hash: u64,
}

/// One persisted index record.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub(crate) struct IndexRecord {
    pub vkey: u128,
    pub primary: u128,
    pub generation: u32,
    pub size: u64,
}

#[derive(Serialize, Deserialize, Default, Debug)]
pub(crate) struct IndexSnapshot {
    pub version: u32,
    /// Oldest (least recently used) first.
    pub entries: Vec<IndexRecord>,
    /// Vary header names per primary key.
    pub vary: Vec<(u128, Vec<String>)>,
}

type WriteDone = Box<dyn FnOnce(io::Result<u64>) + Send>;

enum Job {
    Write {
        path: PathBuf,
        entry: Arc<StoredResponse>,
        done: WriteDone,
    },
    Delete(Vec<PathBuf>),
    SaveIndex(Vec<u8>),
    /// Deletes every file in the cache directory for which `keep` returns false.
    Cleanup(Box<dyn Fn(u128, u32) -> bool + Send>),
    Flush(Sender<()>),
}

/// Handle to the cache directory and its writer thread.
pub(crate) struct DiskStore {
    dir: PathBuf,
    tx: Sender<Job>,
}

impl DiskStore {
    /// Creates the directory and starts the writer thread.
    pub fn open(dir: PathBuf) -> io::Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let (tx, rx) = crossbeam_channel::unbounded();
        let thread_dir = dir.clone();
        std::thread::Builder::new()
            .name("net-cache-io".into())
            .spawn(move || writer_loop(&thread_dir, rx))?;
        Ok(Self { dir, tx })
    }

    pub fn entry_path(&self, vkey: u128, generation: u32) -> PathBuf {
        entry_path(&self.dir, vkey, generation)
    }

    pub fn load_index(&self) -> Option<IndexSnapshot> {
        let path = self.dir.join(INDEX_FILE);
        let bytes = match std::fs::read(&path) {
            Ok(b) => b,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return None,
            Err(e) => {
                log::warn!("cannot read cache index {}: {e}", path.display());
                return None;
            }
        };
        match postcard::from_bytes::<IndexSnapshot>(&bytes) {
            Ok(s) if s.version == INDEX_VERSION => Some(s),
            Ok(_) => None,
            Err(e) => {
                log::warn!("ignoring corrupt cache index: {e}");
                None
            }
        }
    }

    pub fn write(&self, vkey: u128, generation: u32, entry: Arc<StoredResponse>, done: WriteDone) {
        let job = Job::Write {
            path: self.entry_path(vkey, generation),
            entry,
            done,
        };
        if let Err(crossbeam_channel::SendError(job)) = self.tx.send(job)
            && let Job::Write { done, .. } = job
        {
            done(Err(io::Error::other("cache writer thread is gone")));
        }
    }

    pub fn delete(&self, paths: Vec<PathBuf>) {
        if !paths.is_empty() {
            let _ = self.tx.send(Job::Delete(paths));
        }
    }

    pub fn save_index(&self, snapshot: &IndexSnapshot) {
        match postcard::to_allocvec(snapshot) {
            Ok(bytes) => {
                let _ = self.tx.send(Job::SaveIndex(bytes));
            }
            Err(e) => log::warn!("cannot serialize cache index: {e}"),
        }
    }

    pub fn cleanup(&self, keep: Box<dyn Fn(u128, u32) -> bool + Send>) {
        let _ = self.tx.send(Job::Cleanup(keep));
    }

    /// Waits (bounded) until all previously queued jobs have been processed.
    pub fn flush(&self, timeout: Duration) -> bool {
        let (tx, rx) = crossbeam_channel::bounded(1);
        if self.tx.send(Job::Flush(tx)).is_err() {
            return false;
        }
        rx.recv_timeout(timeout).is_ok()
    }
}

fn entry_path(dir: &Path, vkey: u128, generation: u32) -> PathBuf {
    let name = format!("{vkey:032x}-{generation:08x}");
    dir.join(&name[..2]).join(name)
}

fn parse_entry_name(name: &str) -> Option<(u128, u32)> {
    let (key, generation) = name.split_once('-')?;
    if key.len() != 32 || generation.len() != 8 {
        return None;
    }
    Some((
        u128::from_str_radix(key, 16).ok()?,
        u32::from_str_radix(generation, 16).ok()?,
    ))
}

fn writer_loop(dir: &Path, rx: Receiver<Job>) {
    for job in rx {
        match job {
            Job::Write { path, entry, done } => {
                let result = write_entry(&path, &entry);
                if let Err(e) = &result {
                    log::warn!("cache write {} failed: {e}", path.display());
                }
                done(result);
            }
            Job::Delete(paths) => {
                for p in paths {
                    if let Err(e) = std::fs::remove_file(&p)
                        && e.kind() != io::ErrorKind::NotFound
                    {
                        log::debug!("cache delete {} failed: {e}", p.display());
                    }
                }
            }
            Job::SaveIndex(bytes) => {
                if let Err(e) = write_atomic(&dir.join(INDEX_FILE), &bytes, true) {
                    log::warn!("cannot save cache index: {e}");
                }
            }
            Job::Cleanup(keep) => cleanup(dir, &*keep),
            Job::Flush(tx) => {
                let _ = tx.send(());
            }
        }
    }
}

/// Removes orphaned entry files (not referenced by the index), temp files of interrupted
/// writes and anything else unexpected inside the shard directories.
fn cleanup(dir: &Path, keep: &dyn Fn(u128, u32) -> bool) {
    let Ok(shards) = std::fs::read_dir(dir) else { return };
    let mut removed = 0usize;
    for shard in shards.filter_map(Result::ok) {
        let shard_path = shard.path();
        if !shard_path.is_dir() {
            // Leftover temp file of an interrupted index save.
            if shard.file_name().to_str().is_some_and(|n| n.starts_with(".index.bin.")) {
                let _ = std::fs::remove_file(&shard_path);
            }
            continue;
        }
        let Ok(files) = std::fs::read_dir(&shard_path) else { continue };
        for file in files.filter_map(Result::ok) {
            let name = file.file_name();
            let keep_it = name
                .to_str()
                .and_then(parse_entry_name)
                .is_some_and(|(vkey, generation)| keep(vkey, generation));
            if !keep_it && std::fs::remove_file(file.path()).is_ok() {
                removed += 1;
            }
        }
    }
    if removed > 0 {
        log::debug!("cache cleanup removed {removed} orphaned files");
    }
}

fn write_entry(path: &Path, entry: &StoredResponse) -> io::Result<u64> {
    let meta = EntryMeta {
        url: entry.url.clone(),
        status: entry.status,
        http_version: entry.http_version.to_owned(),
        headers: entry.headers.clone(),
        vary: entry.vary.clone(),
        request_time_ms: unix_ms(entry.request_time),
        response_time_ms: unix_ms(entry.response_time),
        body_len: entry.body.len() as u64,
        body_hash: xxhash_rust::xxh3::xxh3_64(&entry.body),
    };
    let meta = postcard::to_allocvec(&meta).map_err(io::Error::other)?;
    let meta_len = u32::try_from(meta.len()).map_err(|_| io::Error::other("metadata too large"))?;
    let dir = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "entry path without parent"))?;
    std::fs::create_dir_all(dir)?;
    let tmp = path.with_extension("tmp");
    let result = (|| {
        let mut f = io::BufWriter::with_capacity(64 * 1024, File::create(&tmp)?);
        f.write_all(MAGIC)?;
        f.write_all(&meta_len.to_le_bytes())?;
        f.write_all(&meta)?;
        f.write_all(&entry.body)?;
        f.into_inner().map_err(|e| e.into_error())?;
        std::fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result.map(|()| 8 + u64::from(meta_len) + entry.body.len() as u64)
}

/// Reads and verifies an entry file. Runs on a blocking thread.
pub(crate) fn read_entry(path: &Path) -> io::Result<StoredResponse> {
    let buf = std::fs::read(path)?;
    let invalid = |what: &str| io::Error::new(io::ErrorKind::InvalidData, format!("corrupt cache entry: {what}"));
    if buf.len() < 8 || &buf[..4] != MAGIC {
        return Err(invalid("bad header"));
    }
    let meta_len = u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]) as usize;
    let body_start = 8usize
        .checked_add(meta_len)
        .filter(|&end| end <= buf.len())
        .ok_or_else(|| invalid("truncated metadata"))?;
    let meta: EntryMeta = postcard::from_bytes(&buf[8..body_start]).map_err(|_| invalid("metadata"))?;
    if (buf.len() - body_start) as u64 != meta.body_len {
        return Err(invalid("truncated body"));
    }
    let body = Bytes::from(buf).slice(body_start..);
    if xxhash_rust::xxh3::xxh3_64(&body) != meta.body_hash {
        return Err(invalid("checksum mismatch"));
    }
    Ok(StoredResponse {
        url: meta.url,
        status: meta.status,
        http_version: intern_version(&meta.http_version),
        headers: meta.headers,
        vary: meta.vary,
        request_time: from_unix_ms(meta.request_time_ms),
        response_time: from_unix_ms(meta.response_time_ms),
        body,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::SystemTime;

    fn sample() -> StoredResponse {
        StoredResponse {
            url: "https://example.com/a.css".into(),
            status: 200,
            http_version: "HTTP/2",
            headers: vec![("content-type".into(), "text/css".into())],
            vary: vec![("accept".into(), Some("text/css".into()))],
            request_time: SystemTime::now(),
            response_time: SystemTime::now(),
            body: Bytes::from_static(b"body { color: red }"),
        }
    }

    #[test]
    fn entry_roundtrip_and_corruption() {
        let dir = tempfile::tempdir().unwrap();
        let path = entry_path(dir.path(), 0xabc, 7);
        let size = write_entry(&path, &sample()).unwrap();
        assert_eq!(size, std::fs::metadata(&path).unwrap().len());
        let back = read_entry(&path).unwrap();
        assert_eq!(back.url, "https://example.com/a.css");
        assert_eq!(back.http_version, "HTTP/2");
        assert_eq!(&back.body[..], b"body { color: red }");
        assert_eq!(back.vary, sample().vary);

        // Flip a body byte: checksum mismatch.
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&path, &bytes).unwrap();
        assert_eq!(read_entry(&path).unwrap_err().kind(), io::ErrorKind::InvalidData);
        // Truncation.
        std::fs::write(&path, &bytes[..bytes.len() / 2]).unwrap();
        assert!(read_entry(&path).is_err());
    }

    #[test]
    fn names_and_cleanup() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(parse_entry_name(&format!("{:032x}-{:08x}", 5u128, 9u32)), Some((5, 9)));
        assert_eq!(parse_entry_name("index.bin"), None);
        let keep_path = entry_path(dir.path(), 1, 1);
        let drop_path = entry_path(dir.path(), 2, 1);
        write_entry(&keep_path, &sample()).unwrap();
        write_entry(&drop_path, &sample()).unwrap();
        std::fs::write(keep_path.with_extension("tmp"), b"partial").unwrap();
        cleanup(dir.path(), &|vkey, _| vkey == 1);
        assert!(keep_path.exists());
        assert!(!drop_path.exists());
        assert!(!keep_path.with_extension("tmp").exists());
    }
}
