<p align="center">
  <img src=".github/assets/banner.svg" alt="Sharko Browser" width="100%">
</p>

<p align="center">
  <a href="../../releases/latest"><img src="https://img.shields.io/github/v/release/Chomeles/sharko-browser?include_prereleases&label=release&color=0b6fa8&style=for-the-badge" alt="Release"></a>
  <a href="../../actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Chomeles/sharko-browser/ci.yml?branch=master&label=CI&style=for-the-badge" alt="CI"></a>
  <img src="https://img.shields.io/badge/language-Rust-dea584?style=for-the-badge&logo=rust" alt="Rust">
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20Linux%20%7C%20macOS-063e6b?style=for-the-badge" alt="Platforms">
  <img src="https://img.shields.io/badge/license-source--available-2ea44f?style=for-the-badge" alt="License">
</p>

<h3 align="center">I didn't like the other browsers.<br>So I made my own. 🦈</h3>

---

Every browser today is either Chromium in a trench coat or a giant legacy codebase.
I wanted something different: **take the fastest open-source component for every single
layer of a browser — and wire them together into one lean, modern, multi-process engine.**

No fork. No Electron. No WebView wrapper. Just Rust, a GPU, and the best parts of
Servo, Firefox, Chrome and the Linebender project, snapped together like Lego.

That's **Sharko**.

> **Status:** early prototype (0.x) — real websites like Wikipedia, Hacker News, GitHub,
> DuckDuckGo or news sites render well; complex web apps partially. Not a daily driver
> *yet*. [Deutsch](README.de.md)

## ✨ Screenshots

<p align="center">
  <img src=".github/assets/wikipedia.png" width="49%" alt="Wikipedia in Sharko">
  <img src=".github/assets/hn.png" width="49%" alt="Hacker News in Sharko">
</p>
<p align="center">
  <img src=".github/assets/newtab.png" width="60%" alt="New tab page">
</p>

## ⚡ Why it's fast

| | |
|---|---|
| 🚀 **Instant window** | The window appears already painted. GPU, network and tab processes start in the background — the UI thread never waits. |
| 🎨 **GPU rendering** | Pages and UI are drawn by [Vello](https://github.com/linebender/vello), a compute-shader 2D renderer, on Vulkan / DX12 / Metal — with a multithreaded CPU fallback. |
| 🧵 **Parallel CSS** | Styles are computed by **Stylo**, Firefox's parallel style engine, across all your cores. |
| 🧱 **Process isolation** | Every tab runs in its own renderer process, Chrome-style. One tab crashes → only that tab shows a sad shark. |
| 🌐 **Modern networking** | HTTP/1.1, HTTP/2 and **HTTP/3 (QUIC)**, rustls with post-quantum key exchange, RFC 9111 cache. |
| 📜 **V8 JavaScript** | The same JS engine as Chrome, with startup snapshots — and no JS runtime at all for pages that don't need one. |
| 🔄 **Signed auto-updates** | ed25519-signed releases via GitHub, installed in the background, active on next start. |

## 🧩 Built from the best

| Layer | Component | Origin |
|---|---|---|
| HTML parsing | [html5ever](https://github.com/servo/html5ever) | Servo |
| CSS / style | [Stylo](https://github.com/servo/stylo) | Firefox |
| Layout | [Taffy](https://github.com/DioxusLabs/taffy) + [Parley](https://github.com/linebender/parley) via [Blitz](https://github.com/DioxusLabs/blitz) | Dioxus / Linebender |
| Fonts / shaping | [Skrifa](https://github.com/googlefonts/fontations) + [HarfRust](https://github.com/harfbuzz/harfrust) | Google Fonts / HarfBuzz |
| Rendering | [Vello](https://github.com/linebender/vello) on [wgpu](https://wgpu.rs) | Linebender / gfx-rs |
| JavaScript | [V8](https://v8.dev) via [rusty_v8](https://github.com/denoland/rusty_v8) | Chrome / Deno |
| Networking | [hyper](https://hyper.rs) / [reqwest](https://github.com/seanmonstar/reqwest), HTTP/3 | Rust ecosystem |
| TLS | [rustls](https://github.com/rustls/rustls) + aws-lc-rs | Rust ecosystem |
| Windowing | [winit](https://github.com/rust-windowing/winit) | Rust ecosystem |

## 🗺️ Roadmap — this is just the beginning

Sharko is my browser, built the way *I* want a browser to work. The engine is the
foundation; now come the features I've always missed elsewhere:

- [ ] 🧑‍🤝‍🧑 **Sessions per tab** — every tab can have its own cookie jar and login. Use several
      accounts on the *same* site side by side (e.g. multiple Microsoft 365 tenants) —
      no more incognito juggling or separate browser profiles.
- [ ] 🎛️ **Hardware acceleration per tab** — switch GPU acceleration on or off for a single
      tab instead of the whole browser.
- [ ] 🛡️ **Built-in ad blocker** support.
- [ ] Bookmarks, downloads, password manager, extensions … and whatever else I like. 😄

## 🏗️ Architecture

```mermaid
flowchart LR
    L["browser.exe<br/><sub>tiny launcher</sub>"] --> C["browser_core.dll<br/><sub>all engine code</sub>"]
    C --> B["🖥️ Browser process<br/><sub>window · tabs · GPU compositor · updater</sub>"]
    B <-->|IPC| N["🌐 Network process<br/><sub>HTTP/1-3 · TLS · cache · cookies</sub>"]
    B <-->|display lists| R1["📄 Renderer · tab 1<br/><sub>DOM · CSS · layout · JS</sub>"]
    B <-->|display lists| R2["📄 Renderer · tab 2"]
    R1 <-->|IPC| N
    R2 <-->|IPC| N
```

Renderers paint pages into serializable **display lists**; the browser process rasterizes
them with Vello on the GPU together with the browser UI (itself HTML/CSS, rendered by the
same engine). Deep dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 📦 Install (Windows)

1. Download `browser-<version>-windows-x64.zip` from the [latest release](../../releases/latest).
2. Unzip anywhere and run `browser.exe` — or `browser.exe --install` for a per-user install
   with Start menu shortcut and automatic updates.

Portable mode: an empty file named `portable` next to `browser.exe` keeps the profile
(cookies, cache, logs) in a `profile` folder beside it.

## 🛠️ Build from source

Requirements: Rust (stable), Python 3 (Stylo's build script), and on Windows the Visual
Studio C++ Build Tools. On Linux also `clang lld libfontconfig1-dev`.

```sh
cargo build                      # debug: target/debug/browser + browser_core library
cargo run -p browser-launcher    # start the browser
cargo run -p browser-launcher -- --headless --screenshot=out.png https://example.com
```

Release package: `cargo build --release -p browser-core -p browser-launcher` then
`cargo xtask package --target <triple>`. Releases are built and signed by GitHub Actions
([docs/RELEASING.md](docs/RELEASING.md)).

## 🤖 Headless mode

```sh
browser --headless --screenshot=page.png https://en.wikipedia.org
browser --headless --full-page --screenshot=full.png https://news.ycombinator.com
browser --headless --eval="document.title" --console https://example.com
browser --headless --dump-dom https://example.com
```

## ⌨️ Keyboard shortcuts

`Ctrl+T` new tab · `Ctrl+W` close · `Ctrl+L` address bar · `Ctrl+Tab` next tab ·
`Alt+←/→` back/forward · `F5` reload · `Ctrl+ +/−/0` zoom · `F11` fullscreen

## 🚧 Known limitations

- No `<canvas>` drawing, video/audio, WebSockets, Web Workers, WebGL yet
- iframes render but run no JavaScript; Shadow DOM is approximated; no `:has()`;
  `position: sticky` only vertically
- No downloads, bookmarks, extensions, password manager yet
- Bot-protection pages (Cloudflare challenges etc.) may block the browser

## 🤝 Contributing & license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

**Source-available, not open source.** You're welcome to read the code, build it, use it
privately and — most importantly — **help develop it** via issues and pull requests. Forking
is fine for preparing pull requests, but publishing your own version or using it
commercially is not allowed. Details: [LICENSE.md](LICENSE.md) (PolyForm Strict 1.0.0 plus a
contribution permission).

Third-party components keep their own licenses (Stylo and a few others are MPL-2.0, V8 is
BSD-3-Clause) — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
