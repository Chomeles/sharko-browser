//! HTTPS against a local server with a generated CA (works with either TLS provider).

mod support;

use netstack::{NetClient, NetConfig};
use support::*;

fn tls_client(ca_pem: &str) -> (NetClient, tempfile::TempDir) {
    let dir = tempfile::tempdir().unwrap();
    let mut config = NetConfig::new(dir.path());
    config.extra_root_certificates_pem = vec![ca_pem.as_bytes().to_vec()];
    (NetClient::in_process_with_config(config), dir)
}

#[test]
fn https_uses_h2_via_alpn_and_rejects_unknown_ca() {
    let server = TlsTestServer::start(false, false);
    let (client, _dir) = tls_client(&server.ca_pem);
    let r = get(&client, &server.url("/hello"));
    assert_eq!(r.status, 200, "{:?}", r.error);
    assert_eq!(r.http_version, "HTTP/2");
    assert_eq!(body_str(&r), "hello world");

    // Without the test CA the certificate is rejected by the platform verifier.
    let (untrusting, _dir2) = support::client();
    let r = get(&untrusting, &server.url("/hello"));
    assert_eq!(r.status, 0);
    assert!(r.error.as_deref().unwrap().contains("ERR_CERT_AUTHORITY_INVALID"), "{:?}", r.error);
}
