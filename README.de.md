# 🦈 Sharko Browser

**Mir haben die anderen Browser nicht gefallen. Also habe ich meinen eigenen gebaut.**

Ein eigener Web-Browser in Rust – aus den schnellsten Open-Source-Komponenten zusammengesetzt,
mit Multi-Prozess-Architektur wie Chrome. Status: **früher Prototyp**. [English](README.md)

## Geplant – das ist erst der Anfang

- **Session pro Tab:** mehrere Konten auf derselben Seite gleichzeitig (z. B. mehrere M365-Tenants)
- **Hardware-Beschleunigung pro Tab** an/aus statt browserweit
- **Adblocker-Unterstützung**

## Installieren (Windows)

1. `browser-<version>-windows-x64.zip` vom [neuesten Release](../../releases/latest) laden.
2. Entpacken und `browser.exe` starten – oder `browser.exe --install` für eine Installation
   mit Startmenü-Eintrag und automatischen Updates.

Portabel: Eine leere Datei `portable` neben `browser.exe` legt das Profil (Cookies, Cache,
Logs) im Ordner `profile` daneben ab statt unter `%LOCALAPPDATA%`.

Updates werden im Hintergrund geladen, geprüft (ed25519-Signatur + SHA-256) und sind nach
dem nächsten Start aktiv.

## Aufbau

| Datei | Inhalt |
|---|---|
| `browser.exe` | Starter (klein): wählt die aktive Version, lädt die Core-Bibliothek |
| `<version>\browser_core.dll` | der komplette Browser-Code (wie `chrome.dll`) |
| `<version>\resources\` | ICU-Daten, eingebaute Seiten, Oberfläche, Übersetzungen |
| `version` | welche Version aktiv ist |

Prozesse (alle = Starter + Core-Bibliothek, Rolle per `--type`):

| Prozess | Aufgabe |
|---|---|
| Browser | Fenster, Tabs, Verlauf, GPU-Compositor, Updater |
| Netzwerk | HTTP/1.1/2/3, TLS, Cache, Cookies (1×) |
| Renderer | DOM, CSS, Layout, JavaScript, Zeichnen (1 pro Tab, abgeschottet) |

## Komponenten

| Aufgabe | Komponente |
|---|---|
| HTML-Parser | html5ever (Servo) |
| CSS | Stylo (Style-Engine von Firefox, parallel) |
| Layout | Taffy + Parley über Blitz |
| Rendering | Vello auf der GPU (wgpu: DirectX 12 / Vulkan / Metal) |
| JavaScript | V8 (Chrome-Engine) |
| Netzwerk | hyper/reqwest, HTTP/2 und HTTP/3 |
| TLS | rustls + aws-lc-rs, Windows-Zertifikatsspeicher |

## Selbst bauen

Voraussetzungen: Rust, Python 3, auf Windows die Visual Studio C++ Build Tools.

```
cargo build
cargo run -p browser-launcher
```

## Tastenkürzel

`Strg+T` neuer Tab · `Strg+W` schließen · `Strg+L` Adressleiste · `Strg+Tab` Tab wechseln ·
`Alt+←/→` zurück/vor · `F5` neu laden · `Strg + / − / 0` Zoom · `F11` Vollbild

## Lizenz

MIT oder Apache-2.0 (nach Wahl). Fremdkomponenten behalten ihre Lizenzen, siehe
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
