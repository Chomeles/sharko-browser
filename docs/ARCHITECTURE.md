# Architecture

## Crates

| Crate | Role |
|---|---|
| `crates/launcher` | `browser(.exe)`: tiny launcher, version selection, launcher self-update swap |
| `crates/core` | `browser_core` shared library: entry point, role dispatch, installer |
| `crates/browser` | browser process: process management, tabs, session history, headless driver, updater |
| `crates/shell` | window (winit), GPU compositor (Vello/wgpu), browser UI (rendered as HTML by Blitz) |
| `crates/engine` | renderer process: navigation, document lifecycle, input, painting into display lists |
| `crates/script` | V8 embedding + native DOM bindings; `js/` holds the DOM/Web-API layer in JavaScript |
| `crates/netstack` | network service: HTTP/1.1/2/3, TLS, cache (RFC 9111), cookies (PSL), Alt-Svc |
| `crates/common` | IPC transport, message protocol, display lists, resources, i18n |
| `crates/xtask` | packaging, release manifests, update signing, third-party notices |
| `vendor/blitz-*` | patched Blitz crates (each change marked `PATCH:`) |

## Processes and IPC

All processes run the same launcher + core library; `--type=renderer|network` selects the
role. The launcher exports the exact library path in `BROWSER_CORE_PATH`, which children
inherit, so a running session never mixes versions even when an update is installed.

IPC uses `interprocess` local sockets (named pipes on Windows, Unix domain sockets
elsewhere) with an authentication token handshake; messages are `postcard`-serialized and
length-prefixed (`crates/common/src/ipc.rs`, `protocol.rs`).

```text
browser ──ToRenderer/FromRenderer──► renderer (per tab)
   │                                    │
   └──ToNetwork/FromNetwork──► network ◄┘   (renderers talk to the network service directly)
```

## Rendering pipeline

1. **Network** fetches the document (network process).
2. **Parse**: html5ever builds the DOM (Blitz `BaseDocument`), with scripting enabled.
3. **Script**: the JS layer runs page scripts in V8 (`crates/script`), mutating the Rust DOM
   through native bindings (single source of truth).
4. **Style**: Stylo computes styles (parallel traversal).
5. **Layout**: Taffy (block/flex/grid/table) + Parley (inline text).
6. **Paint**: Blitz paints into a `DisplayList` (`common::display_list`), fonts and images are
   sent once per renderer and cached by the compositor.
7. **Composite**: the browser process replays the display list into Vello (GPU) together with
   the browser UI.

Frames are produced at most every 16.7 ms, and every 100 ms while a page is still loading
(style work is batched during load).

## Updates

See [RELEASING.md](RELEASING.md). Updater: `crates/browser/src/update.rs`.
