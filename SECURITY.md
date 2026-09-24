# Security policy

This is an early prototype: **do not rely on it for sensitive browsing yet.** Known gaps
include missing OS-level sandboxing of renderer processes and no site isolation beyond
process-per-tab.

## Reporting a vulnerability

Please report vulnerabilities privately via GitHub's
[security advisory form](../../security/advisories/new) rather than public issues. Include
steps to reproduce and the affected version (`browser --version`).

## Update integrity

Updates are only installed if the release manifest carries a valid ed25519 signature from
the project's release key and the package matches the signed SHA-256 checksum
(`crates/browser/src/update.rs`). The private key exists only as a CI secret.
