//! Process-wide registry of `blob:` URLs created with `URL.createObjectURL`, so the
//! renderer's resource loader can serve them (`<img src="blob:…">`, stylesheets, …).
//! Entries are removed by `URL.revokeObjectURL` and when the runtime that created them
//! is dropped.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Contents of a `blob:` URL.
#[derive(Clone, Debug)]
pub struct BlobData {
    pub bytes: Arc<[u8]>,
    /// The Blob's `type` (may be empty).
    pub content_type: String,
}

fn registry() -> &'static Mutex<HashMap<String, BlobData>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, BlobData>>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// Look up a `blob:` URL registered by any runtime in this process (the fragment is
/// ignored). For the renderer's net provider.
pub fn resolve_blob_url(url: &str) -> Option<BlobData> {
    let key = url.split('#').next().unwrap_or(url);
    registry().lock().ok()?.get(key).cloned()
}

pub(crate) fn register(url: String, data: BlobData) {
    if let Ok(mut r) = registry().lock() {
        r.insert(url, data);
    }
}

pub(crate) fn revoke(url: &str) {
    if let Ok(mut r) = registry().lock() {
        r.remove(url);
    }
}
