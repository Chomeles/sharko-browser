# Releasing and updates

## One-time setup

1. Generate the update signing key pair (never commit the private key):

   ```sh
   cargo xtask keygen ~/browser-keys
   ```

2. Put the **public** key into `keys/update-public.key` (committed; compiled into every build).
3. Add the **private** key (content of `update-signing.key`) as repository secret
   `UPDATE_SIGNING_KEY` (Settings → Secrets and variables → Actions).

## Publishing a release

1. Bump `version` in the root `Cargo.toml` (`[workspace.package]`), commit.
2. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.
3. The `Release` workflow builds Windows/Linux/macOS packages, writes `manifest.json` with
   SHA-256 checksums, signs it and publishes everything as a GitHub release.

## How clients update

* The browser checks `https://github.com/<repo>/releases/latest/download/manifest.json`
  20 s after start and then every 6 h (disable with `--no-update`; check manually with
  `--check-update`). The repository is compiled in via `BROWSER_UPDATE_REPO`.
* The manifest signature is verified with the built-in public key; only strictly newer
  versions are accepted; the package's SHA-256 must match the manifest.
* The package is unpacked into a new version folder next to the running one, then the
  `version` file is switched atomically. A new launcher is staged as `browser.exe.new`.
* On the next start the launcher loads the new version; one previous version is kept as
  fallback and older ones are removed.

## Optional: Windows code signing

Unsigned executables trigger SmartScreen warnings. With an Authenticode certificate, add a
`signtool sign` step for `browser.exe` and `browser_core.dll` to the Windows build job
before `cargo xtask package`.
