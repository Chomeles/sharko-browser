# JS DOM / Web-API layer

This is the web platform in plain JavaScript, built on the hidden `__native` object (`N`), which
works on the Rust DOM through numeric node ids. `NATIVE_API.md` is the contract. Read its section
"Additions (requested by JS layer)" for the optional natives, the extra hooks, the default-action
split (onEvent flag `4`) and the load-time purity rules that the startup snapshot needs.

Rust runs these files as classic ES2022 scripts, in this order, once per context:

| file | contents |
|---|---|
| `00_prelude.js` | Captures `N` and deletes `__native`. Defines the shared registry `L` (passed on through `__layer`), wrapper stamping (private fields on node wrappers), DOMException, IDL conversions, the microtask helper and internal timers. |
| `10_events.js` | Event and all its subclasses, EventTarget, the dispatch algorithm (capture/target/bubble plus activation behaviour), inline `on*` handlers with legacy scope, AbortController/AbortSignal. |
| `20_dom.js` | Node, Document, Element, CharacterData, Attr, the fragment types (DocumentFragment, ShadowRoot approximation) and collections (NodeList, HTMLCollection). Also the central mutation paths, which feed MutationObserver, custom element reactions and script insertion. Plus the custom element registry, CSSStyleDeclaration/CSSOM, selectors, TreeWalker/NodeIterator, Range/Selection, geometry (DOMRect, DOMMatrix), DOMParser/XMLSerializer and DOMImplementation. |
| `30_html.js` | HTML/SVG/MathML element classes with IDL attribute reflection. Forms: validation, submission, reset, FormData sources, select/option. Also activation behaviour (checkbox/radio/label/submit/summary), focus, innerText, template, images, media/canvas stubs, dialog, details and tables. |
| `40_webapi.js` | Timers, rAF and idle callbacks, MessageChannel/BroadcastChannel, URL/URLSearchParams, the encodings, Blob/File/FileReader/FormData, streams. Networking: Headers/Request/Response/fetch, XHR. Also crypto, performance, console, navigator, screen, Location/History, storage, matchMedia, the Intersection/Resize/Performance observers, CSS/FontFace and DataTransfer. |
| `90_bootstrap.js` | The Window object and globals, error reporting, the script execution model (parser-blocking, defer, async, module, dynamic scripts, `document.write`), `onEvent` and the other hooks, final hardening (WebIDL-like property attributes, `[native code]`). It deletes `__layer` at the end. |

The page cannot see `__native`, `__layer` or any internal helper.

## Tests

```sh
cd js/test && npm install        # once: parse5, css-select, react, react-dom, preact, vue, jquery, esbuild
node js/test/run.js              # everything (≈5 s); from any directory
node js/test/run.js react        # only files/tests whose name matches /react/i
VERBOSE=1 node js/test/run.js    # also print the page's console output
```

`test/mock_native.js` is a complete `__native` written in JS:
- parse5 for parsing, css-select for selectors, a small cascade for `<style>`/inline styles, fake geometry
- a fake clock with timers, frames and routed fetch responses, plus storage, cookies and history

It follows the Rust semantics: template contents live in content fragments, select state is kept per option, doctypes are dropped, and N.focus can dispatch focus events. Options switch to other native behaviours, e.g. `legacyTemplates`, `noTemplateSupport`, `nativeFocusEvents`, `keepDoctype`, `disable: [...]`. To run the whole suite with extra options, set `MOCK_OPTS='{"nativeFocusEvents":true}'`.

`test/harness.js` gives each test a fresh `node:vm` context and a fake event loop (`env.flush()`). With `checkSnapshot` it also checks load-time purity.

Coverage:
- DOM core and HTML semantics, MutationObserver, custom elements (including customized built-ins), forms and validation
- the script execution model, event dispatch and activation, timers, microtasks and messaging
- networking, URL, encoding, storage, history, observers
- the Rust integration points (`70_integration`) and guards against quadratic hot paths (`80_perf`)
- smoke tests with real libraries: React 19 (production and development builds, bundled with esbuild), Preact + hooks, Vue 3 (global build with the template compiler), and jQuery 3 including `$.ajax`, `$.getJSON` and `$.getScript`

## Known gaps / deviations

- **Shadow DOM is an approximation.** The shadow content is rendered as the host's children and slotted light nodes are moved into their `<slot>`. The host's light-DOM getters therefore see the composed tree. There is no event retargeting, no style scoping (`:host`, `::slotted`), and closed mode only hides `shadowRoot`.
- **No wrapper GC.** Wrappers are cached by node id for the page's lifetime, because expandos and identity must survive. So `N.releaseNode` is never called, and nodes that were ever wrapped stay alive.
- **MutationObserver, custom element reactions and Range only see mutations made through the JS DOM API.** Native changes do not produce records: parser output, user text editing, and Rust-side details toggles or form resets. Ranges are not live: boundary points are not adjusted on mutation.
- **`document.write` is an approximation.** Written markup is parsed as a fragment and inserted after the current parser-inserted script, with an open-element stack for split tags. After load it replaces the body content. Script-created `document.open()` is not a full reset.
- **Unsupported, or stubbed as absent or `null`:** import maps (`<script type=importmap>` is ignored), iframes and nested browsing contexts (`contentWindow` is `null`), Worker/SharedWorker, WebSocket, EventSource, IndexedDB, Notification, WebGL, WebAssembly streaming helpers, `OffscreenCanvas`. Canvas 2D and media elements are inert stubs.
- **`window.open`** returns `null`, even when `N.openWindow` opens a tab. `alert`/`confirm`/`prompt` only log, returning `undefined`/`false`/`null`.
- **The DOMParser XML parser is a small JS parser**: predefined and numeric entities only, no DTDs. XSLT and XPath are not implemented.
- **`innerText` reads computed style element by element**, so it is correct but slow on very large subtrees.
- **The JS-only template fallback** (a native without `N.templateContent`) cannot make native serialization see template contents.
