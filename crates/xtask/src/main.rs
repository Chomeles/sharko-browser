//! Release tooling (`cargo xtask <command>`).
//!
//! ```text
//! cargo xtask keygen <dir>                       new ed25519 update-signing key pair
//! cargo xtask notices                            regenerate THIRD_PARTY_NOTICES.md
//! cargo xtask package --target <triple>          dist/browser-<ver>-<platform>.zip
//! cargo xtask manifest --base-url <url> <zip>... dist/manifest.json (sha256 + sizes)
//! cargo xtask sign <file>                        <file>.sig (key: $UPDATE_SIGNING_KEY)
//! ```
//!
//! Update security: every release carries `manifest.json` (versions, download URLs,
//! SHA-256 of each package) plus `manifest.json.sig`, an ed25519 signature made with a
//! private key that only exists as a CI secret. The browser verifies the signature
//! with the public key compiled into it (`keys/update-public.key`) before downloading
//! anything, then checks the SHA-256 of the package.

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use ed25519_dalek::{Signer, SigningKey};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

type Result<T> = std::result::Result<T, String>;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let r = match args.first().map(String::as_str) {
        Some("keygen") => keygen(args.get(1).map(PathBuf::from)),
        Some("notices") => notices(),
        Some("package") => package(&args[1..]),
        Some("manifest") => manifest(&args[1..]),
        Some("sign") => sign(args.get(1).map(PathBuf::from)),
        _ => Err("usage: cargo xtask <keygen|notices|package|manifest|sign> ...".into()),
    };
    if let Err(e) = r {
        eprintln!("xtask: {e}");
        std::process::exit(1);
    }
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("workspace root")
}

fn workspace_version() -> Result<String> {
    let toml = std::fs::read_to_string(workspace_root().join("Cargo.toml")).map_err(|e| e.to_string())?;
    let mut in_pkg = false;
    for line in toml.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_pkg = l == "[workspace.package]";
        } else if in_pkg && l.starts_with("version") {
            return Ok(l.split('"').nth(1).unwrap_or_default().to_string());
        }
    }
    Err("workspace version not found".into())
}

// ---------------------------------------------------------------------------
// keygen / sign
// ---------------------------------------------------------------------------

fn keygen(dir: Option<PathBuf>) -> Result<()> {
    let dir = dir.unwrap_or_else(|| PathBuf::from("."));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut seed = [0u8; 32];
    getrandom::fill(&mut seed).map_err(|e| e.to_string())?;
    let key = SigningKey::from_bytes(&seed);
    let private = B64.encode(key.to_bytes());
    let public = B64.encode(key.verifying_key().to_bytes());
    let priv_path = dir.join("update-signing.key");
    std::fs::write(&priv_path, format!("{private}\n")).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("update-public.key"), format!("{public}\n")).map_err(|e| e.to_string())?;
    println!("private key: {} (KEEP SECRET: store as CI secret UPDATE_SIGNING_KEY)", priv_path.display());
    println!("public key:  {public} (commit as keys/update-public.key)");
    Ok(())
}

fn signing_key() -> Result<SigningKey> {
    let b64 = match std::env::var("UPDATE_SIGNING_KEY") {
        Ok(k) if !k.trim().is_empty() => k,
        _ => {
            let file = std::env::var("UPDATE_SIGNING_KEY_FILE")
                .map_err(|_| "set UPDATE_SIGNING_KEY or UPDATE_SIGNING_KEY_FILE")?;
            std::fs::read_to_string(file).map_err(|e| e.to_string())?
        }
    };
    let bytes = B64.decode(b64.trim()).map_err(|e| e.to_string())?;
    let seed: [u8; 32] = bytes.try_into().map_err(|_| "signing key must be 32 bytes")?;
    Ok(SigningKey::from_bytes(&seed))
}

fn sign(file: Option<PathBuf>) -> Result<()> {
    let file = file.ok_or("usage: cargo xtask sign <file>")?;
    let data = std::fs::read(&file).map_err(|e| e.to_string())?;
    let key = signing_key()?;
    // Refuse to sign with a key that doesn't match the public key the app trusts.
    let trusted = std::fs::read_to_string(workspace_root().join("keys/update-public.key"))
        .map_err(|e| e.to_string())?;
    if B64.encode(key.verifying_key().to_bytes()) != trusted.trim() {
        return Err("signing key does not match keys/update-public.key".into());
    }
    let sig = key.sign(&data);
    let out = PathBuf::from(format!("{}.sig", file.display()));
    std::fs::write(&out, format!("{}\n", B64.encode(sig.to_bytes()))).map_err(|e| e.to_string())?;
    println!("signed {} -> {}", file.display(), out.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// package
// ---------------------------------------------------------------------------

fn platform_of(target: &str) -> Result<&'static str> {
    Ok(match target {
        t if t.starts_with("x86_64-pc-windows") => "windows-x64",
        t if t.starts_with("aarch64-pc-windows") => "windows-arm64",
        t if t.starts_with("x86_64-unknown-linux") => "linux-x64",
        t if t.starts_with("aarch64-unknown-linux") => "linux-arm64",
        t if t.starts_with("aarch64-apple") => "macos-arm64",
        t if t.starts_with("x86_64-apple") => "macos-x64",
        other => return Err(format!("unsupported target {other}")),
    })
}

fn opt(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let prefix = format!("--{name}=");
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == &flag {
            return it.next().cloned();
        }
        if let Some(v) = a.strip_prefix(&prefix) {
            return Some(v.to_string());
        }
    }
    None
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Source path of a crate from the dependency graph (e.g. to take ICU data from).
fn crate_dir(name: &str) -> Result<PathBuf> {
    let out = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(["metadata", "--format-version", "1"])
        .current_dir(workspace_root())
        .output()
        .map_err(|e| e.to_string())?;
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    meta["packages"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["name"] == name)
        .and_then(|p| p["manifest_path"].as_str())
        .and_then(|m| Path::new(m).parent().map(Path::to_path_buf))
        .ok_or_else(|| format!("crate {name} not in dependency graph"))
}

fn package(args: &[String]) -> Result<()> {
    let root = workspace_root();
    let target = opt(args, "target").ok_or("--target <triple> required")?;
    let profile = opt(args, "profile").unwrap_or_else(|| "release".into());
    let version = opt(args, "version").unwrap_or(workspace_version()?);
    let platform = platform_of(&target)?;
    let windows = target.contains("windows");
    let (exe, lib) = if windows {
        ("browser.exe", "browser_core.dll")
    } else if target.contains("apple") {
        ("browser", "libbrowser_core.dylib")
    } else {
        ("browser", "libbrowser_core.so")
    };
    let build = opt(args, "build-dir")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("target").join(&target).join(&profile));
    let name = format!("browser-{version}-{platform}");
    let dist = root.join("dist");
    let stage = dist.join(&name);
    let _ = std::fs::remove_dir_all(&stage);
    let vdir = stage.join(&version);
    std::fs::create_dir_all(&vdir).map_err(|e| e.to_string())?;

    std::fs::copy(build.join(exe), stage.join(exe))
        .map_err(|e| format!("{}: {e} (build first)", build.join(exe).display()))?;
    std::fs::copy(build.join(lib), vdir.join(lib))
        .map_err(|e| format!("{}: {e} (build first)", build.join(lib).display()))?;
    copy_dir(&root.join("resources"), &vdir.join("resources"))?;
    let icu = crate_dir("deno_core_icudata")?.join("src/icudtl.dat");
    std::fs::copy(&icu, vdir.join("resources/icudtl.dat"))
        .map_err(|e| format!("{}: {e}", icu.display()))?;
    std::fs::write(stage.join("version"), &version).map_err(|e| e.to_string())?;
    for f in ["LICENSE.md", "THIRD_PARTY_NOTICES.md", "README.md"] {
        let src = root.join(f);
        if src.is_file() {
            std::fs::copy(&src, stage.join(f)).map_err(|e| e.to_string())?;
        }
    }

    // Zip (deflate), paths relative to the package root.
    let zip_path = dist.join(format!("{name}.zip"));
    let file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(std::io::BufWriter::new(file));
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated)
        .compression_level(Some(9))
        .large_file(true);
    let mut files = Vec::new();
    collect_files(&stage, &mut files)?;
    files.sort();
    for f in files {
        let rel = f.strip_prefix(&stage).map_err(|e| e.to_string())?;
        let rel = rel.to_string_lossy().replace('\\', "/");
        let mode = if rel == exe || rel.ends_with(lib) { 0o755 } else { 0o644 };
        zip.start_file(rel, opts.unix_permissions(mode)).map_err(|e| e.to_string())?;
        let data = std::fs::read(&f).map_err(|e| e.to_string())?;
        zip.write_all(&data).map_err(|e| e.to_string())?;
    }
    zip.finish().map_err(|e| e.to_string())?;
    println!("{}", zip_path.display());
    Ok(())
}

fn collect_files(dir: &Path, out: &mut Vec<PathBuf>) -> Result<()> {
    for entry in std::fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            collect_files(&entry.path(), out)?;
        } else {
            out.push(entry.path());
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

fn manifest(args: &[String]) -> Result<()> {
    let base_url = opt(args, "base-url").ok_or("--base-url <url> required")?;
    let version = opt(args, "version").unwrap_or(workspace_version()?);
    let out = opt(args, "out").map(PathBuf::from).unwrap_or_else(|| workspace_root().join("dist/manifest.json"));
    let mut platforms = serde_json::Map::new();
    let mut skip = false;
    for a in args {
        if skip {
            skip = false;
            continue;
        }
        if a == "--base-url" || a == "--version" || a == "--out" {
            skip = true;
            continue;
        }
        if a.starts_with("--") {
            continue;
        }
        let path = PathBuf::from(a);
        let data = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        // browser-<version>-<platform>.zip
        let platform = file_name
            .trim_end_matches(".zip")
            .strip_prefix(&format!("browser-{version}-"))
            .ok_or_else(|| format!("{file_name}: expected browser-{version}-<platform>.zip"))?
            .to_string();
        let sha = Sha256::digest(&data);
        let hex: String = sha.iter().map(|b| format!("{b:02x}")).collect();
        platforms.insert(
            platform,
            serde_json::json!({
                "url": format!("{}/{}", base_url.trim_end_matches('/'), file_name),
                "sha256": hex,
                "size": data.len(),
            }),
        );
    }
    let doc = serde_json::json!({
        "version": version,
        "platforms": platforms,
    });
    std::fs::write(&out, serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())? + "\n")
        .map_err(|e| e.to_string())?;
    println!("{}", out.display());
    Ok(())
}

// ---------------------------------------------------------------------------
// notices
// ---------------------------------------------------------------------------

/// THIRD_PARTY_NOTICES.md: every crate linked into the product with its license.
fn notices() -> Result<()> {
    let root = workspace_root();
    let out = Command::new(std::env::var("CARGO").unwrap_or_else(|_| "cargo".into()))
        .args(["metadata", "--format-version", "1"])
        .current_dir(&root)
        .output()
        .map_err(|e| e.to_string())?;
    let meta: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    let packages = meta["packages"].as_array().cloned().unwrap_or_default();
    let resolve = &meta["resolve"]["nodes"];
    // Walk normal dependencies from the shipped crates.
    let ids: std::collections::HashMap<String, serde_json::Value> = packages
        .iter()
        .map(|p| (p["id"].as_str().unwrap_or_default().to_string(), p.clone()))
        .collect();
    let nodes: std::collections::HashMap<String, serde_json::Value> = resolve
        .as_array()
        .into_iter()
        .flatten()
        .map(|n| (n["id"].as_str().unwrap_or_default().to_string(), n.clone()))
        .collect();
    let mut stack: Vec<String> = packages
        .iter()
        .filter(|p| p["name"] == "browser-core" || p["name"] == "browser-launcher")
        .map(|p| p["id"].as_str().unwrap_or_default().to_string())
        .collect();
    let mut seen = std::collections::BTreeSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if let Some(node) = nodes.get(&id) {
            for dep in node["deps"].as_array().into_iter().flatten() {
                let normal = dep["dep_kinds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|k| k["kind"].is_null());
                if normal {
                    if let Some(d) = dep["pkg"].as_str() {
                        stack.push(d.to_string());
                    }
                }
            }
        }
    }
    let mut rows: Vec<(String, String, String, String)> = seen
        .iter()
        .filter_map(|id| ids.get(id))
        .filter(|p| p["source"].is_string()) // skip workspace crates
        .map(|p| {
            (
                p["name"].as_str().unwrap_or_default().to_string(),
                p["version"].as_str().unwrap_or_default().to_string(),
                p["license"].as_str().unwrap_or("see repository").to_string(),
                p["repository"].as_str().unwrap_or("").to_string(),
            )
        })
        .collect();
    rows.sort();
    rows.dedup();
    let mut md = String::from(
        "# Third-party notices\n\nThis program includes the following open-source components \
         (generated by `cargo xtask notices`). Their license texts are available in the \
         linked repositories and in the crate sources.\n\n\
         Additionally bundled:\n\n\
         * **V8** (via rusty_v8) — BSD-3-Clause, © The V8 project authors\n\
         * **ICU data** (`icudtl.dat`) — Unicode License v3, © Unicode, Inc.\n\
         * **Public Suffix List** — MPL-2.0, © Mozilla Foundation\n\n\
         | Crate | Version | License | Repository |\n|---|---|---|---|\n",
    );
    for (n, v, l, r) in &rows {
        md.push_str(&format!("| {n} | {v} | {l} | {r} |\n"));
    }
    std::fs::write(root.join("THIRD_PARTY_NOTICES.md"), md).map_err(|e| e.to_string())?;
    println!("THIRD_PARTY_NOTICES.md: {} crates", rows.len());
    Ok(())
}
