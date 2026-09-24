//! Real-world smoke test through the environment's proxy (HTTPS_PROXY) and OS trust
//! store. Run manually:
//!
//! ```text
//! cargo test -p netstack --test real_sites -- --ignored --nocapture
//! ```

mod support;

use netstack::{Destination, NetClient, NetRequest};
use support::*;

#[test]
#[ignore = "needs internet access"]
fn example_com_and_wikipedia() {
    let dir = tempfile::tempdir().unwrap();
    let client = NetClient::in_process(dir.path().to_path_buf());
    for url in ["https://example.com/", "https://www.wikipedia.org/"] {
        let r = fetch(&client, NetRequest::get(0, url, Destination::Document));
        println!(
            "{url}: {} {} via {} -> {} ({} bytes decoded, {:.0} ms, content-type {:?}, error {:?})",
            r.status,
            r.status_text,
            r.http_version,
            r.url,
            r.body.len(),
            r.duration_ms,
            r.header("content-type"),
            r.error,
        );
        assert_eq!(r.status, 200, "{url}: {:?}", r.error);
        assert!(r.error.is_none());
        assert!(!r.body.is_empty());
        assert!(body_str(&r).to_ascii_lowercase().contains("<html"), "decoded HTML expected");
        assert!(["HTTP/1.1", "HTTP/2", "HTTP/3"].contains(&r.http_version.as_str()));

        // Second load: served from the cache or revalidated.
        let again = fetch(&client, NetRequest::get(0, url, Destination::Document));
        println!(
            "{url} again: {} via {} from_cache={} ({:.0} ms)",
            again.status, again.http_version, again.from_cache, again.duration_ms
        );
        assert_eq!(again.status, 200);
    }
}
