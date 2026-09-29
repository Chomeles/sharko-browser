# Reference implementations: where to read, what may be ported

Rule of the project: **before designing a fix for a web-platform gap, read how a working engine does it, and port the algorithm** (not the site-specific symptom). Use the running Chromium as the behavioural oracle (`tools/sitediff`, `tools/diffmine`), and the source below as the recipe.

## Licences and what that allows (not legal advice)

| Engine | Language | Licence | Direct port into this repo |
|---|---|---|---|
| Ladybird (LibWeb) | C++ | BSD-2-Clause | Yes: translate code, keep the notice. Best match: small, spec-shaped, comments quote the spec steps. |
| Chromium / Blink | C++ | BSD-3-Clause | Yes with notice; huge and entangled with Blink internals, so usually read for behaviour and edge cases. |
| Servo (script, layout, net) | Rust | MPL-2.0 | Yes, but ported/copied files stay MPL-2.0: keep the MPL header in that file and list it in THIRD_PARTY_NOTICES.md. Same language as our engine, so this is the natural source for Rust code. |
| Firefox / Gecko | C++ | MPL-2.0 | Read for behaviour; port only in separate files with the MPL header. |
| WebKit | C++ | BSD-2 + LGPL parts | Read for behaviour; do not copy LGPL files. |

When code is ported: put `// Ported from <project> <path> (<licence>): <what>` above it, add the source and licence to `THIRD_PARTY_NOTICES.md`, and describe the deviation in the commit message. Never copy without understanding: adapt to our data model (`vendor/blitz-dom` nodes, the JS layer's `N.*` natives).

## Where things are (GitHub raw paths; they move, so check the directory first)

Ladybird `https://github.com/LadybirdBrowser/ladybird/tree/master/Libraries/LibWeb/`:
- `DOM/` (ShadowRoot.cpp, Node.cpp, Element.cpp, Document.cpp, Range.cpp, MutationObserver, slot assignment in `Slottable`/`Element`), `HTML/` (`Parser/HTMLParser.cpp` = the spec's tree construction step by step, `HTMLScriptElement.cpp`, `Window`, `Navigable`), `CSS/` (`ContainerQuery.cpp`, `StyleComputer`, `Parser/`), `Layout/` (`FormattingContext`, `BlockFormattingContext`, `FlexFormattingContext`, `GridFormattingContext`, `TableFormattingContext`; file names change, list the directory), `Painting/`, `Fetch/`, `XHR/`, `IndexedDB/` (`IDBDatabase.cpp` etc.), `Streams/`, `WebIDL/` (conversion rules), `XPath/`, `Selection/`, `Editing/`.

Servo `https://github.com/servo/servo/tree/main/components/`:
- `script/dom/` (DOM in Rust: `shadowroot.rs`, `node.rs`, `element.rs`; some files were split into subdirectories), `layout/` (new layout), `net/` (fetch, cookies, HSTS, cache), `script/` (script runtime glue). Stylo (`https://github.com/servo/stylo`) is our style engine: read its `style/dom.rs` traits for what a DOM must provide (shadow roots, slots, flat tree).

Chromium `https://github.com/chromium/chromium/tree/main/third_party/blink/renderer/core/`:
- `dom/` (`shadow_root.cc`, `slot_assignment`), `html/parser/` (`html_tree_builder.cc`, `html_document_parser.cc`), `css/` (`container_query_evaluator.cc`, `css_properties.json5` = the property table), `layout/` (LayoutNG: `flex/`, `grid/`, `block/`, `inline/`, `table/`), `paint/`, `script/` (script loading), and `net/` (top-level, HTTP/cookies/TLS: header order, `http_util`).

Gecko `https://github.com/mozilla/gecko-dev/`: `dom/base/` (`ShadowRoot.cpp`, `nsContentUtils.cpp`), `layout/` (frame classes: `nsFlexContainerFrame.cpp`, `nsGridContainerFrame.cpp`), `parser/html/` (`nsHtml5TreeBuilder` generated from Java), `dom/indexedDB/`, `netwerk/` (cookies, cache, http).

Specs: https://html.spec.whatwg.org, https://dom.spec.whatwg.org, https://drafts.csswg.org, https://fetch.spec.whatwg.org, https://w3c.github.io/IndexedDB; web-platform-tests (`/home/user/wpt`, `tools/wpt/README.md`) are the shared test suite of all engines.

## How to use this in a task

1. Find the code path in the reference (start from the spec algorithm name; Ladybird's comments quote spec steps, so grep the step text).
2. Write down the rules it follows and the edge cases it handles (as a comment block or in the commit message).
3. Reproduce the difference against Chromium first (minimal page), then implement in our structure, then run the WPT directory for the area.
4. Keep attribution as described above.
