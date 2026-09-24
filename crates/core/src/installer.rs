//! Per-user installation (no admin rights needed), like Chrome's user-level install.
//!
//! Layout created by `--install`:
//!
//! ```text
//! Windows: %LOCALAPPDATA%\Programs\Browser\        Linux: ~/.local/share/browser-app/
//!   browser(.exe)                                   launcher
//!   version                                         active version, e.g. "0.1.0"
//!   0.1.0\browser_core.dll                          core library
//!   0.1.0\resources\...                             data files
//! ```
//!
//! Windows additionally gets Start menu + desktop shortcuts and an entry in
//! "Apps & features" (HKCU uninstall key). Auto-updates add new version folders next to
//! the old one; the launcher switches on the next start.

use std::io;
use std::path::{Path, PathBuf};

pub const APP_NAME: &str = "Browser";

fn install_root() -> Option<PathBuf> {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs").join(APP_NAME))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share/browser-app"))
    }
}

fn core_lib_name() -> &'static str {
    if cfg!(windows) {
        "browser_core.dll"
    } else if cfg!(target_os = "macos") {
        "libbrowser_core.dylib"
    } else {
        "libbrowser_core.so"
    }
}

fn copy_dir(src: &Path, dst: &Path) -> io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir(&entry.path(), &target)?;
        } else {
            std::fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

fn report(msg: &str, ok: bool) -> i32 {
    if ok {
        println!("{msg}");
    } else {
        eprintln!("{msg}");
    }
    #[cfg(windows)]
    {
        // Started from Explorer (no console): show the result in a message box via
        // PowerShell-free Win32 would need more bindings; `msg` output goes to the
        // attached console when started from a terminal.
        let _ = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-WindowStyle",
                "Hidden",
                "-Command",
                &format!(
                    "Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('{}', '{}') | Out-Null",
                    msg.replace('\'', "''"),
                    APP_NAME
                ),
            ])
            .status();
    }
    if ok { 0 } else { 1 }
}

pub fn install() -> i32 {
    match do_install() {
        Ok(root) => report(
            &format!("{} {}", common::i18n::t("install.done"), root.display()),
            true,
        ),
        Err(e) => report(&format!("{} {e}", common::i18n::t("install.failed")), false),
    }
}

fn do_install() -> io::Result<PathBuf> {
    let root = install_root().ok_or_else(|| io::Error::other("no install location"))?;
    let version = crate::VERSION;
    let exe = std::env::current_exe()?;
    let core = std::env::var_os("BROWSER_CORE_PATH")
        .map(PathBuf::from)
        .or_else(|| exe.parent().map(|p| p.join(core_lib_name())))
        .ok_or_else(|| io::Error::other("core library not found"))?;
    let version_dir = root.join(version);
    std::fs::create_dir_all(&version_dir)?;

    let exe_name = if cfg!(windows) { "browser.exe" } else { "browser" };
    let dest_exe = root.join(exe_name);
    if dest_exe != exe {
        std::fs::copy(&exe, &dest_exe)?;
    }
    let dest_core = version_dir.join(core_lib_name());
    if dest_core != core {
        std::fs::copy(&core, &dest_core)?;
    }
    let resources = common::resources::dir();
    let dest_res = version_dir.join("resources");
    if resources != dest_res {
        copy_dir(resources, &dest_res)?;
    }
    // License texts travel with the program.
    if let Some(src_root) = exe.parent() {
        for f in ["LICENSE-MIT", "LICENSE-APACHE", "THIRD_PARTY_NOTICES.md"] {
            let p = src_root.join(f);
            if p.is_file() && src_root != root {
                let _ = std::fs::copy(&p, root.join(f));
            }
        }
    }
    std::fs::write(root.join("version"), version)?;

    #[cfg(windows)]
    windows_integration(&root, &dest_exe, version)?;
    #[cfg(target_os = "linux")]
    linux_integration(&dest_exe)?;
    Ok(root)
}

#[cfg(windows)]
fn windows_integration(root: &Path, exe: &Path, version: &str) -> io::Result<()> {
    use std::process::Command;
    let exe_s = exe.display().to_string();
    // Shortcuts via the WScript.Shell COM object.
    let script = format!(
        "$s=New-Object -ComObject WScript.Shell; \
         foreach($p in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {{ \
           $l=$s.CreateShortcut((Join-Path $p '{name}.lnk')); $l.TargetPath='{exe}'; \
           $l.WorkingDirectory='{dir}'; $l.Description='{name}'; $l.Save() }}",
        name = APP_NAME,
        exe = exe_s.replace('\'', "''"),
        dir = root.display().to_string().replace('\'', "''"),
    );
    let _ = Command::new("powershell")
        .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
        .status();
    // "Apps & features" entry (per-user, no admin needed).
    let key = format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_NAME}");
    let set = |name: &str, kind: &str, value: &str| {
        let _ = Command::new("reg")
            .args(["add", &key, "/v", name, "/t", kind, "/d", value, "/f"])
            .status();
    };
    set("DisplayName", "REG_SZ", APP_NAME);
    set("DisplayVersion", "REG_SZ", version);
    set("Publisher", "REG_SZ", "Open Source");
    set("InstallLocation", "REG_SZ", &root.display().to_string());
    set("DisplayIcon", "REG_SZ", &exe_s);
    set("UninstallString", "REG_SZ", &format!("\"{exe_s}\" --uninstall"));
    set("NoModify", "REG_DWORD", "1");
    set("NoRepair", "REG_DWORD", "1");
    Ok(())
}

#[cfg(target_os = "linux")]
fn linux_integration(exe: &Path) -> io::Result<()> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Ok(());
    };
    let apps = home.join(".local/share/applications");
    std::fs::create_dir_all(&apps)?;
    std::fs::write(
        apps.join("browser-app.desktop"),
        format!(
            "[Desktop Entry]\nType=Application\nName={APP_NAME}\nExec=\"{}\" %U\nTerminal=false\nCategories=Network;WebBrowser;\nMimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;\n",
            exe.display()
        ),
    )
}

pub fn uninstall() -> i32 {
    let Some(root) = install_root() else {
        return report(common::i18n::t("uninstall.none"), false);
    };
    #[cfg(windows)]
    {
        use std::process::Command;
        let script = format!(
            "foreach($p in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {{ \
               Remove-Item -ErrorAction SilentlyContinue (Join-Path $p '{APP_NAME}.lnk') }}"
        );
        let _ = Command::new("powershell")
            .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script])
            .status();
        let key = format!(r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\{APP_NAME}");
        let _ = Command::new("reg").args(["delete", &key, "/f"]).status();
        // The running launcher/library can't delete themselves: remove the folder after
        // this process has exited.
        let _ = Command::new("cmd")
            .args([
                "/C",
                &format!(
                    "ping -n 3 127.0.0.1 >NUL & rmdir /S /Q \"{}\"",
                    root.display()
                ),
            ])
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = std::fs::remove_dir_all(&root);
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            let _ = std::fs::remove_file(home.join(".local/share/applications/browser-app.desktop"));
        }
    }
    report(common::i18n::t("uninstall.done"), true)
}
