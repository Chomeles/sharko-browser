# Browser

**A web browser written in Rust, assembled from the fastest open-source engine components,
with a Chromium-style multi-process architecture.** *(Working title — the project has no name
yet.)*

> Status: **early prototype (0.x)**. Many sites work well, complex web apps partially.
> Not a daily driver yet. [Deutsch](README.de.md)

| Area | Component |
|---|---|
| HTML parsing | [html5ever](https://github.com/servo/html5ever) (Servo) |
| CSS / style | [Stylo](https://github.com/servo/stylo) — Firefox's parallel style engine |
| Layout | [Taffy](https://github.com/DioxusLabs/taffy) (flex, grid, block) + [Parley](https://github.com/linebender/parley) (text), integrated via [Blitz](https://github.com/DioxusLabs/blitz) |
| Fonts / shaping | [Skrifa](https://github.com/googlefonts/fontations) + [HarfRust](https://github.com/harfbuzz/harfrust) |
| Rendering | [Vello](https://github.com/linebender/vello) (GPU compute) on [wgpu](https://wgpu.rs) (DX12/Vulkan/Metal); vello_cpu fallback |
| JavaScript | [V8](https://v8.dev) via [rusty_v8](https://github.com/denoland/rusty_v8), with startup snapshots |
| Networking | [hyper](https://hyper.rs)/[reqwest](https://github.com/seanmonstar/reqwest): HTTP/1.1, HTTP/2, HTTP/3 (QUIC) |
| TLS | [rustls](https://github.com/rustls/rustls) + aws-lc-rs (post-quantum key exchange), OS certificate store |
| Windowing | [winit](https://github.com/rust-windowing/winit) |

## Install (Windows)

1. Download `browser-<version>-windows-x64.zip` from the [latest release](../../releases/latest).
2. Unzip anywhere and run `browser.exe` — or run `browser.exe --install` for a per-user
   installation with Start menu shortcut and automatic updates.

Updates are downloaded in the background, verified (ed25519 signature + SHA-256) and become
active on the next start.

## Architecture

```text
browser.exe                  launcher (tiny): picks the active version, loads the core library
<version>/browser_core.dll   all browser code (one library, like chrome.dll)
<version>/resources/         ICU data, built-in pages, UI, translations

Processes (all = launcher + core library, role chosen by --type):
  browser   window, tabs, history, GPU compositor, updater
  network   HTTP/1.1/2/3, TLS, cache, cookies        (one)
  renderer  DOM, CSS, layout, JavaScript, paint      (one per tab, crash-isolated)
```

Renderers paint pages into serializable **display lists** which the browser process
rasterizes with Vello on the GPU. More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Build from source

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

## Headless mode

```sh
browser --headless --screenshot=page.png https://en.wikipedia.org
browser --headless --full-page --screenshot=full.png https://news.ycombinator.com
browser --headless --eval="document.title" --console https://example.com
browser --headless --dump-dom https://example.com
```

## Keyboard shortcuts

`Ctrl+T` new tab · `Ctrl+W` close · `Ctrl+L` address bar · `Ctrl+Tab` next tab ·
`Alt+←/→` back/forward · `F5` reload · `Ctrl+ +/−/0` zoom · `F11` fullscreen

## Known limitations

- No `<canvas>` drawing, video/audio, WebSockets, Web Workers, WebGL yet
- iframes render but run no JavaScript; Shadow DOM is approximated; no `:has()`, no `position: sticky`
- No downloads, bookmarks, extensions, password manager yet
- Bot-protection pages (Cloudflare challenges etc.) may block the browser

## Contributing & license

See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md).

Licensed under either of [Apache License 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT) at your
option. Third-party components keep their licenses (Stylo and a few others are MPL-2.0, V8 is
BSD-3-Clause) — see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
