//! Automatic updates from GitHub Releases.
//!
//! Every release publishes (see `.github/workflows/release.yml`, `cargo xtask`):
//!
//! * `browser-<ver>-<platform>.zip` — launcher + `<ver>/` folder (core library, resources)
//! * `manifest.json` — `{ version, platforms: { <platform>: { url, sha256, size } } }`
//! * `manifest.json.sig` — ed25519 signature of `manifest.json`
//!
//! The check (background thread in the browser process, via the network service):
//!
//! 1. download `manifest.json` + `.sig` from `releases/latest/download/`,
//! 2. verify the signature with the public key compiled into this build
//!    (`keys/update-public.key`) — nothing unsigned is ever trusted,
//! 3. accept only strictly newer versions (no downgrades via old manifests),
//! 4. download the package for this platform and check its SHA-256 from the manifest,
//! 5. unpack `<ver>/` next to the running version (never touching it), write the new
//!    `version` file; a new launcher is staged as `browser.new(.exe)`.
//!
//! The new version starts with the next launch; the running session keeps using its
//! already loaded library (child processes are pinned via `BROWSER_CORE_PATH`).

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use common::protocol::{CacheMode, Destination, NetRequest, NetResponse};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use netstack::NetClient;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Public key that release manifests must be signed with.
const UPDATE_PUBLIC_KEY: &str = include_str!("../../../keys/update-public.key");

/// `owner/repo` on GitHub, injected by the release workflow. Development builds have
/// none and never update.
pub const UPDATE_REPO: Option<&str> = option_env!("BROWSER_UPDATE_REPO");

const MAX_MANIFEST: usize = 256 * 1024;
const MAX_PACKAGE: usize = 512 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq)]
pub enum UpdateStatus {
    /// Updates are not configured for this build / installation layout.
    Disabled(String),
    UpToDate,
    /// A newer version was installed and becomes active on the next start.
    Installed(String),
    Failed(String),
}

#[derive(Debug, Clone)]
pub struct UpdateConfig {
    /// URL of the release manifest.
    pub manifest_url: String,
    /// Running version.
    pub current_version: String,
    /// Installation root (folder with the launcher, `version` and version folders).
    pub install_root: PathBuf,
    /// Package platform key, e.g. `windows-x64`.
    pub platform: &'static str,
}

/// Platform key of this build (matches `cargo xtask package`).
pub fn current_platform() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("windows", "x86_64") => "windows-x64",
        ("windows", "aarch64") => "windows-arm64",
        ("linux", "x86_64") => "linux-x64",
        ("linux", "aarch64") => "linux-arm64",
        ("macos", "aarch64") => "macos-arm64",
        ("macos", "x86_64") => "macos-x64",
        _ => "unknown",
    }
}

impl UpdateConfig {
    /// Configuration for this process, or why updates are disabled.
    pub fn detect(current_version: &str) -> Result<UpdateConfig, String> {
        let manifest_url = match std::env::var("BROWSER_UPDATE_MANIFEST") {
            Ok(url) => url,
            Err(_) => match UPDATE_REPO {
                Some(repo) if !repo.is_empty() => {
                    format!("https://github.com/{repo}/releases/latest/download/manifest.json")
                }
                _ => return Err("development build (no update source)".into()),
            },
        };
        // <root>/<version>/browser_core.dll  →  <root>
        let core = std::env::var_os("BROWSER_CORE_PATH")
            .map(PathBuf::from)
            .ok_or("not started through the launcher")?;
        let root = core
            .parent()
            .and_then(Path::parent)
            .ok_or("unexpected installation layout")?
            .to_path_buf();
        if !root.join("version").is_file() {
            return Err("portable/development layout (no version file)".into());
        }
        Ok(UpdateConfig {
            manifest_url,
            current_version: current_version.to_string(),
            install_root: root,
            platform: current_platform(),
        })
    }
}

fn parse_version(s: &str) -> Option<Vec<u64>> {
    let core = s.trim().trim_start_matches('v').split(['-', '+']).next()?;
    core.split('.').map(|p| p.parse().ok()).collect()
}

/// `a > b` for dotted numeric versions.
pub fn is_newer(a: &str, b: &str) -> bool {
    match (parse_version(a), parse_version(b)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn fetch_blocking(net: &NetClient, url: &str, timeout: Duration) -> Result<NetResponse, String> {
    let (tx, rx) = crossbeam_channel::bounded(1);
    let mut req = NetRequest::get(0, url, Destination::Fetch);
    req.credentials = false;
    req.cache_mode = CacheMode::NoStore;
    req.headers.push(("Accept".into(), "application/octet-stream, application/json".into()));
    net.fetch(
        req,
        Box::new(move |resp| {
            let _ = tx.send(resp);
        }),
    );
    let resp = rx.recv_timeout(timeout).map_err(|_| format!("timeout: {url}"))?;
    if let Some(e) = &resp.error {
        return Err(format!("{url}: {e}"));
    }
    if !(200..300).contains(&resp.status) {
        return Err(format!("{url}: HTTP {}", resp.status));
    }
    Ok(resp)
}

/// Verify `data` against a base64 ed25519 signature with the compiled-in public key.
pub fn verify_signature(data: &[u8], signature_b64: &str) -> Result<(), String> {
    verify_with_key(data, signature_b64, UPDATE_PUBLIC_KEY)
}

fn verify_with_key(data: &[u8], signature_b64: &str, public_b64: &str) -> Result<(), String> {
    let key_bytes: [u8; 32] = B64
        .decode(public_b64.trim())
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "bad public key length")?;
    let key = VerifyingKey::from_bytes(&key_bytes).map_err(|e| e.to_string())?;
    let sig_bytes = B64.decode(signature_b64.trim()).map_err(|e| e.to_string())?;
    let sig = Signature::try_from(sig_bytes.as_slice()).map_err(|e| e.to_string())?;
    key.verify(data, &sig).map_err(|_| "invalid signature".to_string())
}

/// Check for a newer version and install it. Blocking (run on a background thread).
pub fn check_and_install(net: &NetClient, cfg: &UpdateConfig) -> UpdateStatus {
    match try_update(net, cfg) {
        Ok(s) => s,
        Err(e) => UpdateStatus::Failed(e),
    }
}

fn try_update(net: &NetClient, cfg: &UpdateConfig) -> Result<UpdateStatus, String> {
    let manifest = fetch_blocking(net, &cfg.manifest_url, Duration::from_secs(30))?;
    if manifest.body.len() > MAX_MANIFEST {
        return Err("manifest too large".into());
    }
    let sig = fetch_blocking(net, &format!("{}.sig", cfg.manifest_url), Duration::from_secs(30))?;
    verify_signature(&manifest.body, &String::from_utf8_lossy(&sig.body))?;

    let doc: serde_json::Value =
        serde_json::from_slice(&manifest.body).map_err(|e| format!("manifest: {e}"))?;
    let version = doc["version"].as_str().ok_or("manifest without version")?.to_string();
    if !is_newer(&version, &cfg.current_version) {
        return Ok(UpdateStatus::UpToDate);
    }
    if parse_version(&version).is_none() || version.contains(['/', '\\']) {
        return Err("invalid version in manifest".into());
    }
    let target_dir = cfg.install_root.join(&version);
    if target_dir.is_dir()
        && std::fs::read_to_string(cfg.install_root.join("version")).ok().as_deref().map(str::trim)
            == Some(version.as_str())
    {
        // Already installed by an earlier check; waiting for a restart.
        return Ok(UpdateStatus::Installed(version));
    }
    let entry = &doc["platforms"][cfg.platform];
    let url = entry["url"].as_str().ok_or(format!("no package for {}", cfg.platform))?;
    let expected_sha = entry["sha256"].as_str().ok_or("manifest without sha256")?.to_ascii_lowercase();
    // Packages must come over https; a developer-supplied manifest override
    // (BROWSER_UPDATE_MANIFEST, for testing) may point to local files.
    let override_active = std::env::var_os("BROWSER_UPDATE_MANIFEST").is_some();
    if !url.starts_with("https://") && !(override_active && url.starts_with("file://")) {
        return Err("package URL must be https".into());
    }

    let package = fetch_blocking(net, url, Duration::from_secs(600))?;
    if package.body.len() > MAX_PACKAGE {
        return Err("package too large".into());
    }
    let actual: String = Sha256::digest(&package.body).iter().map(|b| format!("{b:02x}")).collect();
    if actual != expected_sha {
        return Err(format!("checksum mismatch ({actual} != {expected_sha})"));
    }
    install_package(&package.body, &version, &cfg.install_root)?;
    Ok(UpdateStatus::Installed(version))
}

/// Unpack `<version>/...` (and a new launcher) from a verified package into `root`.
pub fn install_package(zip_bytes: &[u8], version: &str, root: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| e.to_string())?;
    let staging = root.join(format!("{version}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let exe_name = if cfg!(windows) { "browser.exe" } else { "browser" };
    let mut new_launcher: Option<Vec<u8>> = None;
    let prefix = format!("{version}/");

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        // Reject absolute paths / `..` (zip slip).
        let Some(name) = file.enclosed_name() else { continue };
        let name = name.to_string_lossy().replace('\\', "/");
        if file.is_dir() {
            continue;
        }
        let mut data = Vec::with_capacity(file.size() as usize);
        std::io::copy(&mut file, &mut data).map_err(|e| e.to_string())?;
        if name == exe_name {
            new_launcher = Some(data);
        } else if let Some(rel) = name.strip_prefix(&prefix) {
            let dest = rel.split('/').fold(staging.clone(), |p, c| p.join(c));
            if let Some(parent) = dest.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&dest, &data).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(mode));
                }
            }
        }
    }
    let final_dir = root.join(version);
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&staging, &final_dir).map_err(|e| e.to_string())?;

    if let Some(bytes) = new_launcher {
        let current = std::fs::read(root.join(exe_name)).unwrap_or_default();
        if current != bytes {
            let staged = root.join(format!("{exe_name}.new"));
            std::fs::write(&staged, &bytes).map_err(|e| e.to_string())?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    // Switch the active version atomically (write + rename).
    let tmp = root.join("version.tmp");
    std::fs::write(&tmp, version).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, root.join("version")).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn version_order() {
        assert!(is_newer("0.2.0", "0.1.9"));
        assert!(is_newer("1.0.0", "0.99.99"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("garbage", "0.1.0"));
    }

    #[test]
    fn signatures() {
        let key = SigningKey::from_bytes(&[7u8; 32]);
        let public = B64.encode(key.verifying_key().to_bytes());
        let sig = B64.encode(key.sign(b"manifest").to_bytes());
        assert!(verify_with_key(b"manifest", &sig, &public).is_ok());
        assert!(verify_with_key(b"manifest!", &sig, &public).is_err());
        let other = B64.encode(SigningKey::from_bytes(&[8u8; 32]).verifying_key().to_bytes());
        assert!(verify_with_key(b"manifest", &sig, &other).is_err());
    }

    #[test]
    fn unpack_package() {
        use std::io::Write;
        let dir = std::env::temp_dir().join(format!("upd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("version"), "0.1.0").unwrap();
        let mut buf = Vec::new();
        {
            let mut z = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("0.2.0/resources/x.txt", o).unwrap();
            z.write_all(b"hello").unwrap();
            z.start_file("../evil.txt", o).unwrap();
            z.write_all(b"nope").unwrap();
            z.start_file(if cfg!(windows) { "browser.exe" } else { "browser" }, o).unwrap();
            z.write_all(b"launcher").unwrap();
            z.finish().unwrap();
        }
        install_package(&buf, "0.2.0", &dir).unwrap();
        assert_eq!(std::fs::read_to_string(dir.join("0.2.0/resources/x.txt")).unwrap(), "hello");
        assert_eq!(std::fs::read_to_string(dir.join("version")).unwrap(), "0.2.0");
        assert!(!dir.parent().unwrap().join("evil.txt").exists());
        let exe = if cfg!(windows) { "browser.exe.new" } else { "browser.new" };
        assert!(dir.join(exe).is_file());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
