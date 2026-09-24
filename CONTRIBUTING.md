# Contributing

Thanks for helping! Bug reports with a URL and a headless screenshot are the most useful:

```sh
browser --headless --console --screenshot=out.png <url>
```

## Development

```sh
cargo build                                   # everything (debug)
cargo run -p browser-launcher                 # run the browser
cargo test -p common -p browser -p netstack   # fast tests
cargo test -p script                          # V8 runtime tests
node crates/script/js/test/run.js             # JS DOM layer tests (after npm install in js/test)
```

Where things live: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Debugging

| Variable / flag | Effect |
|---|---|
| `BROWSER_TRACE_STARTUP=1` | startup milestones, UI-thread stalls, paint rate |
| `BROWSER_DEBUG_EVENTS=1` | log window and renderer events |
| `--cpu` (or `BROWSER_RENDERER=cpu`) | render the UI with vello_cpu |
| `BROWSER_ALLOW_SOFTWARE_GPU=1` | also use software GPU adapters (lavapipe, WARP) |
| `WGPU_BACKEND`, `WGPU_ADAPTER_NAME`, `WGPU_POWER_PREF` | GPU backend / adapter choice |
| `--single-process` | network service and renderers as threads |
| `portable` file next to the launcher | profile (and logs) in `profile/` beside it |

## Guidelines

* Keep changes focused; add a test or a headless reproduction where possible.
* Engine fixes in `vendor/blitz-*` must be marked with a `PATCH:` comment (so they can be
  upstreamed to [Blitz](https://github.com/DioxusLabs/blitz)).
* The native API between Rust and the JS layer is specified in
  `crates/script/js/NATIVE_API.md` — update it together with both sides.
* User-visible text goes into `resources/locales/*.json`.
* Run `cargo fmt` before committing.

By contributing you agree that your contributions are licensed under MIT OR Apache-2.0.
