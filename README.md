# Browser (Prototyp, ohne Namen)

Ein eigener Web-Browser in Rust – aus den schnellsten verfügbaren Komponenten zusammengesetzt,
mit echter Multi-Prozess-Architektur wie Chrome.

## Komponenten

| Aufgabe | Komponente | Sprache |
|---|---|---|
| HTML-Parser | html5ever (Servo) | Rust |
| CSS / Style | Stylo (Firefox-Style-Engine, parallel) | Rust |
| Layout | Taffy (Flexbox, Grid, Block) + Parley (Text) über Blitz | Rust |
| Text-Shaping | HarfRust (HarfBuzz-Port) + Skrifa (Fontations, auch in Chrome) | Rust |
| Rendering | Vello (GPU, Compute-Shader) über wgpu; vello_cpu als Fallback | Rust |
| GPU-API | wgpu (DirectX 12 / Vulkan / Metal) | Rust |
| JavaScript | V8 (Chrome-Engine) über rusty_v8, mit Startup-Snapshot | C++ |
| Netzwerk | hyper + reqwest, HTTP/1.1, HTTP/2, HTTP/3 (QUIC) | Rust |
| TLS | rustls + aws-lc-rs (inkl. Post-Quanten-Schlüsseltausch) | Rust/C |
| Zertifikate | rustls-platform-verifier (Windows-Zertifikatsspeicher) | Rust |
| Cache / Cookies | eigener RFC-9111-Cache (Speicher + Festplatte), cookie_store mit Public-Suffix-Liste | Rust |
| IPC | Named Pipes (Windows) / Unix-Sockets, postcard-Serialisierung | Rust |
| Fenster | winit | Rust |

## Prozesse

```
browser.exe                     Browser-Prozess: Fenster, Tabs, Verlauf, GPU-Compositor
browser.exe --type=network      Netzwerk-Prozess: HTTP, TLS, Cache, Cookies (1x)
browser.exe --type=renderer     Renderer-Prozess: DOM, CSS, Layout, JavaScript (1 pro Tab)
```

Der Renderer malt jede Seite in eine **Display-Liste** (Zeichenbefehle), schickt sie per IPC an
den Browser-Prozess, und der rendert sie mit Vello auf der GPU. Stürzt ein Tab ab, laufen die
anderen weiter (der Tab zeigt „Diese Seite ist abgestürzt“ + Neu laden).

## Ordnerstruktur

```
crates/common     IPC, Nachrichten-Protokoll, Display-Listen
crates/netstack   Netzwerk-Stack + Netzwerk-Prozess
crates/script     V8-Einbindung + native DOM-Bindings (Rust)
crates/script/js  DOM- und Web-API-Schicht in JavaScript (auf den nativen Bindings)
crates/engine     Renderer-Prozess: Laden, Parsen, Style, Layout, JS, Painting
crates/browser    Browser-Prozess: Prozessverwaltung, Tabs, Verlauf, Headless-Modus
crates/shell      Oberfläche: Fenster, Tab-Leiste, Adressleiste (selbst als HTML/CSS gerendert)
vendor/           angepasste Blitz-Crates (Engine-Fixes, markiert mit „PATCH:“)
app/              main(): startet je nach --type die richtige Rolle
tools/            Build-Skripte (Windows-Cross-Build)
```

## Bedienung

| Taste | Funktion |
|---|---|
| Strg+T / Strg+W | Neuer Tab / Tab schließen |
| Strg+L, F6, Alt+D | Adressleiste |
| Strg+Tab, Strg+Bild↑/↓, Strg+1…9 | Tab wechseln |
| Alt+← / Alt+→ | Zurück / Vor |
| F5 / Strg+R | Neu laden |
| Strg + / − / 0, Strg+Mausrad | Zoom |
| F11 | Vollbild |

In der Adressleiste: URL oder Suchbegriff (Suche über DuckDuckGo).

## Headless-Modus (ohne Fenster, zum Testen)

```
browser.exe --headless --screenshot=bild.png https://de.wikipedia.org
browser.exe --headless --full-page --screenshot=ganz.png https://news.ycombinator.com
browser.exe --headless --eval="document.title" https://example.com
browser.exe --headless --dump-dom https://example.com
```

Weitere Optionen: `browser.exe --help`.

## Selbst bauen

Windows (nativ): Rust (rustup), Visual Studio Build Tools (C++), Python 3 (für Stylo).
```
cargo build --release -p app
target\release\browser.exe
```

Linux → Windows (Cross-Build): `tools/build-windows.sh` (clang-cl + lld-link + xwin).

## Grenzen des Prototyps

- Komplexe Web-Apps (YouTube, Google Docs) funktionieren nur teilweise.
- Kein `<canvas>`-Zeichnen, keine Videos/Audio, keine WebSockets, keine Web-Worker.
- iframes werden angezeigt, aber haben kein eigenes JavaScript.
- Shadow DOM nur angenähert, `:has()`-Selektoren fehlen.
- Keine Downloads, Lesezeichen, Erweiterungen, Passwortspeicher.
- Bot-Schutz-Seiten (Cloudflare-Challenge, Amazon) erkennen den Browser als Bot.
