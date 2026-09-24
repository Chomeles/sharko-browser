# Native API contract (Rust <-> JS)

The Rust renderer embeds V8. Before any page script runs, Rust creates a context and
installs ONE hidden global object `__native` (called `N` below), then executes the JS
layer files in this directory in this order:

1. `00_prelude.js`   – captures `N = globalThis.__native`, deletes the global, sets up
                       internal registry objects (`__priv` symbols etc.)
2. `10_events.js`    – Event classes + EventTarget
3. `20_dom.js`       – Node / Element / Document / collections / CSSOM
4. `30_html.js`      – HTML element subclasses (input, a, img, script, form, template, ...)
5. `40_webapi.js`    – URL, TextEncoder/Decoder, fetch/Headers/Request/Response, XHR,
                       Blob, FormData, AbortController, MessageChannel, storage, timers,
                       rAF, performance, crypto, navigator, location, history, observers…
6. `90_bootstrap.js` – creates `window`/`document` globals, registers hooks with `N.setHooks`

All files are plain classic scripts (no ES modules, no imports). They share state via a
single IIFE-local object passed through `globalThis.__layer` which `90_bootstrap.js`
deletes at the end. Page scripts must NOT be able to see `__native` or `__layer`.

## Conventions

* Node ids are JS numbers (integers < 2^53). **`0` means "no node" / null.**
* Strings are JS strings. Arrays are plain JS arrays.
* Native functions throw a JS `Error` (message prefixed with the DOMException name,
  e.g. `"SyntaxError: ..."`, `"HierarchyRequestError: ..."`) on invalid input. The JS
  layer should convert these into `DOMException` instances where it matters.
* Any function that reads layout (`getBoundingClientRect`, `offsetMetrics`, …) makes
  Rust flush style + layout first. It's synchronous.
* Mutations are applied immediately to the Rust DOM (single source of truth). The JS
  layer must NOT keep its own copy of the tree; wrappers are thin views over ids.

## Node type codes (`N.nodeType`)
1 = Element, 3 = Text, 8 = Comment, 9 = Document, 11 = DocumentFragment, 10 = Doctype.

## Tree / identity
| function | returns |
|---|---|
| `N.documentId()` | id of the Document node |
| `N.nodeType(id)` | number (see above) |
| `N.localName(id)` | element local name, lowercase for HTML (e.g. `"div"`, `"svg"`, `"foreignObject"`); `""` for non-elements |
| `N.namespaceURI(id)` | `"http://www.w3.org/1999/xhtml"`, `"http://www.w3.org/2000/svg"`, `"http://www.w3.org/1998/Math/MathML"` or `""` |
| `N.parent(id)` | parent id or 0 |
| `N.firstChild(id)` / `N.lastChild(id)` | id or 0 |
| `N.nextSibling(id)` / `N.prevSibling(id)` | id or 0 |
| `N.childIds(id)` | array of child ids (all node types, in order) |
| `N.childElementIds(id)` | array of element child ids |
| `N.isConnected(id)` | bool – is the node in the document tree |
| `N.contains(a, b)` | bool – `b` is `a` or a descendant of `a` |
| `N.compareDocumentPosition(a, b)` | number, DOM bitmask semantics |

## Creation
| function | returns |
|---|---|
| `N.createElement(localName, nsOrEmpty)` | new detached element id. `nsOrEmpty` `""` = HTML namespace |
| `N.createText(data)` | id |
| `N.createComment(data)` | id |
| `N.createFragment()` | id of a detached DocumentFragment (nodeType 11) |
| `N.cloneNode(id, deep)` | id of the clone (detached) |

## Mutation (return `undefined`)
| function | notes |
|---|---|
| `N.appendChild(parent, child)` | if `child` is a fragment, its children are moved instead (fragment ends up empty) |
| `N.insertBefore(parent, child, refOr0)` | `refOr0 == 0` → append. Fragment semantics as above |
| `N.removeChild(parent, child)` | detaches; node stays alive (JS may re-insert it) |
| `N.replaceChild(parent, newChild, oldChild)` | |

(Insertion of `<style>`, `<link rel=stylesheet>`, `<img>` etc. is handled by Rust
automatically – stylesheets/images load. **`<script>` insertion is NOT executed by Rust**
– the JS layer is responsible for running scripts, see "Scripts" below.)

## Attributes
| function | returns |
|---|---|
| `N.getAttr(id, name)` | string or `null` |
| `N.setAttr(id, name, value)` | – (name is used as-is; lowercase it in JS for HTML elements) |
| `N.removeAttr(id, name)` | – |
| `N.hasAttr(id, name)` | bool |
| `N.attrNames(id)` | array of attribute names in order |

## Character data / content
| function | returns |
|---|---|
| `N.getText(id)` | data of a Text or Comment node |
| `N.setText(id, data)` | – |
| `N.textContent(id)` | concatenated text of descendants (element/fragment/document) |
| `N.setTextContent(id, text)` | replaces all children with one text node (or none if `""`) |
| `N.innerHTML(id)` | serialized children |
| `N.setInnerHTML(id, html)` | parses as fragment in context of element and replaces children. Scripts inside are NOT executed (spec behaviour) |
| `N.outerHTML(id)` | serialized node |
| `N.parseHTMLFragment(html)` | id of a new fragment containing the parsed nodes (used for insertAdjacentHTML, outerHTML setter, createContextualFragment, DOMParser for fragments) |

## Selectors (throw `"SyntaxError: ..."` on bad selector)
| function | returns |
|---|---|
| `N.querySelector(scopeId, sel)` | first matching descendant id or 0 |
| `N.querySelectorAll(scopeId, sel)` | array of ids in document order |
| `N.matches(id, sel)` | bool |
| `N.closest(id, sel)` | id or 0 |
| `N.getElementById(idString)` | id or 0 (searches the document) |

## Layout / geometry (forces style+layout)
| function | returns |
|---|---|
| `N.getBoundingClientRect(id)` | `[x, y, width, height]` viewport-relative CSS px |
| `N.getClientRects(id)` | flat array `[x,y,w,h, x,y,w,h, ...]` |
| `N.offsetMetrics(id)` | `[offsetLeft, offsetTop, offsetWidth, offsetHeight, offsetParentId]` |
| `N.clientMetrics(id)` | `[clientLeft, clientTop, clientWidth, clientHeight]` |
| `N.scrollMetrics(id)` | `[scrollLeft, scrollTop, scrollWidth, scrollHeight]` |
| `N.setScroll(id, left, top)` | scroll an element (for the document element / body this scrolls the viewport) |
| `N.scrollIntoView(id)` | – |
| `N.elementFromPoint(x, y)` | id or 0 |
| `N.viewport()` | `[innerWidth, innerHeight, devicePixelRatio, scrollX, scrollY, screenWidth, screenHeight]` |
| `N.scrollTo(x, y)` | scroll viewport |

## Inline style (element.style) and computed style
| function | returns |
|---|---|
| `N.styleGet(id, cssPropName)` | value string (`""` if not set). Property names are CSS names (`background-color`, `--custom`) |
| `N.styleGetPriority(id, cssPropName)` | `"important"` or `""` |
| `N.styleSet(id, cssPropName, value, priority)` | – (`value === ""` removes) |
| `N.styleRemove(id, cssPropName)` | previous value string |
| `N.styleCssText(id)` | serialized declaration block |
| `N.styleSetCssText(id, text)` | – |
| `N.styleLength(id)` / `N.styleItem(id, i)` | number / property name |
| `N.computedStyle(id, cssPropName, pseudoOrEmpty)` | resolved value string (forces style) |
| `N.cssSupports(prop, value)` | bool |
| `N.matchMedia(query)` | bool – evaluates a media query against the current viewport |

## Forms / focus / interaction
| function | returns |
|---|---|
| `N.getValue(id)` | current value of input/textarea/select (live editing state) |
| `N.setValue(id, value)` | – |
| `N.getChecked(id)` / `N.setChecked(id, bool)` | checkbox / radio |
| `N.getSelectedIndex(id)` / `N.setSelectedIndex(id, i)` | `<select>` |
| `N.focus(id)` / `N.blur(id)` | – |
| `N.activeElement()` | id or 0 |
| `N.runDefaultAction(id, type)` | performs the browser default action for a synthetic event of `type` (`"click"`: follow link, toggle checkbox/radio, submit form, open details…). Called by JS after dispatching a synthetic `click()` that was not cancelled |
| `N.submitForm(formId, submitterIdOr0)` | navigates with the form data |

## Scripts & modules
| function | returns |
|---|---|
| `N.evalScript(source, url, isInline)` | runs a classic script in the global scope, returns completion value. **Exceptions are reported by Rust to the console (with stack) and re-thrown** |
| `N.runModule(url, sourceOrNull)` | loads a module graph (fetching `url` if `sourceOrNull` is null; for inline modules `url` is the document URL + a unique fragment), instantiates and evaluates it. Returns a `Promise` resolving when evaluation completes (rejecting on error) |
| `N.compileFunction(bodySource, argNames[], url)` | returns a Function (used for inline event handler attributes like `onclick="..."`) |

## Networking
| function | returns |
|---|---|
| `N.fetch(reqId, method, url, headersFlat, body, mode)` | starts a request, returns undefined. `headersFlat` = `[name, value, name, value…]`. `body` = `null`, string, or `ArrayBuffer`. `mode` = `"cors"`/`"no-cors"`/`"same-origin"`/`"navigate"` (informational). Completion is delivered through hook `onFetch` |
| `N.abortFetch(reqId)` | – |
| `N.getCookie()` | `document.cookie` string for the current document URL |
| `N.setCookie(str)` | – |

## Storage (kind 0 = localStorage, 1 = sessionStorage)
`N.storageGet(kind, key)` → string|null, `N.storageSet(kind, key, value)`,
`N.storageRemove(kind, key)`, `N.storageClear(kind)`, `N.storageKeys(kind)` → array.

## Timers / frames
| function | returns |
|---|---|
| `N.setTimer(timerId, delayMs)` | schedule a one-shot native timer; when due Rust calls hook `onTimer(timerId)`. Repeating intervals are implemented in JS by re-arming |
| `N.clearTimer(timerId)` | – |
| `N.requestFrame()` | ask Rust to call hook `onFrame(timestampMs)` before the next paint |
| `N.now()` | ms since navigation start (float, like `performance.now()`) |
| `N.timeOrigin()` | epoch ms of navigation start |

## Location / history / navigation
| function | returns |
|---|---|
| `N.location()` | current document URL (string) |
| `N.navigate(url, replace)` | begin navigation of this tab |
| `N.reload()` | – |
| `N.historyPush(url, replace)` | same-document URL change (pushState/replaceState). Rust updates the document URL; state objects are kept in JS |
| `N.historyGo(delta)` | – |
| `N.setTitle(title)` | tell the browser the document title changed |

## Misc
| function | returns |
|---|---|
| `N.log(level, message)` | level: `"log"`,`"info"`,`"warn"`,`"error"`,`"debug"` |
| `N.urlParse(input, baseOrNull)` | `null` if invalid, else array `[href, protocol, username, password, host, hostname, port, pathname, search, hash, origin]` (WHATWG URL, computed by the Rust `url` crate) |
| `N.randomBytes(n)` | ArrayBuffer with n cryptographically random bytes |
| `N.textEncode(str)` | ArrayBuffer (UTF-8) |
| `N.textDecode(arrayBufferOrView, label, fatal)` | string (throws on unknown label or on invalid data if fatal) |
| `N.userAgent()` | UA string |
| `N.structuredClone(value)` | deep clone using V8's ValueSerializer |
| `N.pendingResourceCount()` | number of subresources (stylesheets/images/fonts) still loading – used to decide when to fire `window.load` |

## Hooks (JS → registered once with `N.setHooks(obj)`)
Rust calls these; exceptions thrown inside hooks are reported to the console.

| hook | when | return |
|---|---|---|
| `onDocumentParsed()` | once, right after the initial HTML was parsed into the DOM. JS must now run the parser-inserted scripts (see below), then fire `DOMContentLoaded`, then (once `N.pendingResourceCount()==0` and all scripts done) fire `load` on window | – |
| `onEvent(type, targetId, pathIds, init)` | a native UI event (mouse/pointer/keyboard/wheel/focus/input/scroll/...) needs JS dispatch. `pathIds` = target → … → document (ids). `init` = plain object: `{bubbles, cancelable, composed, clientX, clientY, screenX, screenY, pageX, pageY, offsetX, offsetY, button, buttons, detail, key, code, location, repeat, isComposing, ctrlKey, shiftKey, altKey, metaKey, deltaX, deltaY, deltaZ, deltaMode, pointerId, pointerType, isPrimary, inputType, data, relatedTargetId}` (fields present as relevant). JS must build the right Event subclass, dispatch it (capture → target → bubble, also to `document` and `window` at the end of the path), including inline `on*` attribute handlers and IDL `onclick` properties | number bit flags: `1` = defaultPrevented, `2` = propagation stopped |
| `onTimer(timerId)` | a timer registered by `N.setTimer` is due | – |
| `onFrame(timestampMs)` | a frame is being produced and `N.requestFrame()` was called | – |
| `onFetch(reqId, status, statusText, finalUrl, headersFlat, bodyArrayBuffer, errorOrNull)` | fetch finished. On network error `status` is 0 and `errorOrNull` is a message | – |
| `onResourcesLoaded()` | called whenever `pendingResourceCount` drops to 0 | – |
| `onViewportChanged()` | viewport resized → JS dispatches `resize` on window | – |
| `onScroll()` | viewport scrolled → JS dispatches `scroll` on document (bubbling to window) | – |
| `onPageHide()` | before navigating away → `pagehide`, `beforeunload` (ignore result), `unload` | – |

## Script execution model (implemented in JS)
After `onDocumentParsed`:
1. Collect all `<script>` elements in document order that were present in the initial DOM.
   Skip scripts whose `type` is not a JS MIME type (`""`, `text/javascript`,
   `application/javascript`, `module`, …); `nomodule` scripts are skipped.
2. External classic scripts without `async`/`defer` and inline classic scripts run in
   document order ("parser-blocking"). Fetch all external scripts in parallel up front
   (via `N.fetch`), execute in order as they become available.
3. `defer` scripts and `type=module` scripts (non-async) run after that, in order.
4. `async` scripts run whenever they arrive.
5. While running a script, `document.currentScript` is that element; `document.readyState`
   goes `"loading"` → `"interactive"` (before DOMContentLoaded) → `"complete"` (before load).
6. `document.write()`/`writeln()` while a parser-inserted script is running: parse the
   HTML and insert the resulting nodes right after the current script element (approximation).
   After load, `document.write` replaces the document body content.
7. Scripts inserted later by JS (`appendChild` of a `<script>` element, or of a subtree
   containing scripts, that becomes connected) execute exactly once: inline ones
   immediately (synchronously during the insertion call), external ones asynchronously
   after fetch; then fire `load` (or `error`) on the element. Setting `.src`/`.text` on an
   already-started script does nothing. Scripts inserted via `innerHTML` never execute.
8. Script errors must not stop the loop: catch, report via `N.log("error", …)` with stack,
   dispatch an `ErrorEvent` on window (`window.onerror` support), continue.

## Additions (requested by JS layer)

Everything here is optional unless noted. JS feature-detects each native with
`typeof N.x === 'function'` and has a fallback. Existing semantics above are unchanged.

### Natives
| function | semantics (fallback when absent) |
|---|---|
| `N.historyIndex()` / `N.historyLength()` | index of the current session-history entry (0-based) / number of entries. JS keys `pushState` states by index. (JS counters) |
| `N.referrer()` | `document.referrer`. Read lazily, never while the layer loads. (`""`) |
| `N.openWindow(url, target, features)` | `window.open` for a new top-level context (a target other than `_self`/`_top`/`_parent`/own name). `javascript:` URLs are never passed. The page gets `null`. (no-op) |
| `N.imageSize(id)` | `[naturalWidth, naturalHeight]` of a decoded `<img>`, or `null`. (layout size once `load` was seen) |
| `N.parseHTMLDocument(html)` | id of a new detached DocumentFragment with the parsed document's children (`<html>` with `<head>`/`<body>`; no doctype node, JS adds one). Scripting disabled; template contents are in their content fragments. JS wraps it as a Document (DOMParser, `createHTMLDocument`). (JS builds html/head/body and uses `setInnerHTML`) |
| `N.registerBlobURL(url, arrayBuffer, type)` / `N.revokeBlobURL(url)` | mirror of `URL.createObjectURL`/`revokeObjectURL`, so Rust can load `blob:` URLs in `src`/`href`. fetch/XHR of `blob:` stay in JS. |
| `N.fetchSync(method, url, headersFlat, bodyOrNull, credentials)` | synchronous request for sync XHR. Returns `[status, statusText, finalUrl, headersFlat, bodyArrayBuffer\|null, errorOrNull]`; status 0 + error if unsupported. (sync XHR throws `InvalidAccessError`) |
| `N.clipboardWrite(text)` | `navigator.clipboard.writeText`. |
| `N.doctype()` | `[name, publicId, systemId]` of the main document's `<!DOCTYPE>` as parsed, or `null` if the source had none (then JS reports quirks mode). The Rust DOM has no DocumentType nodes, so at `onDocumentParsed` JS inserts a comment-backed DocumentType before `<html>`. It does the same for DOMParser and `createHTMLDocument` documents, reading the doctype from the markup there. (`<!DOCTYPE html>` assumed) |
| `N.fetch(reqId, method, url, headersFlat, body, mode, credentials, cache, redirect)` | trailing args added to `N.fetch`. `credentials`: `"omit"`, `"same-origin"` (default) or `"include"`. `cache`: a RequestCache value. `redirect`: `"follow"`, `"error"` or `"manual"`. For `"error"` and `"manual"` Rust does not follow; on a 3xx JS rejects (`"error"`) or returns an `opaqueredirect` Response (`"manual"`). What JS passes: `fetch()` uses the Request's values; XHR sends `include` if `withCredentials`, else `same-origin`; classic scripts send `include` (no `crossorigin` or `use-credentials`) or `same-origin` (anonymous); `sendBeacon` sends `include`. |
| `N.templateContent(id)` | (Rust addition) id of a `<template>`'s content fragment, created on demand. Native innerHTML/outerHTML/setInnerHTML/cloneNode treat it as the template's contents. After every parse, JS calls it for each `<template>`, so parsed contents that a native left as children get moved. (JS-side fragments; native serialization then cannot see them) |
| `N.setShadowHost(id, isHost)` | (Rust addition) marks `id` as the host of an emulated shadow tree: `<style>`/`<link>` stylesheets inside it only apply to its subtree (`:host`, `::slotted()` supported). Called by `attachShadow` and for declarative shadow roots. |
| `N.setDefined(id)` | (Rust addition) the custom element `id` was upgraded or created from its definition: CSS `:defined` matches it (built-in elements always match). |
| `N.setIndeterminate(id, bool)` | (Rust addition) mirrors `input.indeterminate` for `:indeterminate` matching. |
| `N.urlSet(href, field, value)` | (Rust addition) urlParse-style components after applying a WHATWG URL setter; used by `URL`/`Location`/`<a>` setters. (JS approximation) |
| `N.workerCreate()` / `N.workerEval(global, source, url)` / `N.cloneInto(global, value)` | (Rust addition) dedicated workers: a new JS realm (V8 context with only the ECMAScript builtins, same security token) whose global JS fills with the worker API; `workerEval` runs a classic script there and returns `null` or `[message, url, line, column, error]`; `cloneInto` structured-clones `value` into that realm. Worker code runs on the page's thread. (`Worker` throws `NotSupportedError`) |
| `N.wsOpen(id, url, protocols, origin)` / `N.wsSend(id, stringOrArrayBuffer)` / `N.wsClose(id, code, reason)` | (Rust addition) the `WebSocket` connection, opened in the network process. `url` is an absolute `ws:`/`wss:` URL, `code` is `-1` for none. `wsOpen` returns `false` when the host has no WebSocket support (JS then fires `error` and `close`). Events come back through `onWebSocket`. |

### Hooks (registered through `N.setHooks`, called by Rust)
| hook | when / what JS does |
|---|---|
| `onElementEvent(id, type)` | `"load"`/`"error"` of an element's subresource (img, stylesheet link, …). JS fires the non-bubbling event on the element; an img also updates `complete`/`naturalWidth`. |
| `onPopState(url, index)` | Rust changed the document URL through a same-document fragment navigation it performed (called synchronously, after the new history entry) or through a host-driven traversal. JS fires `popstate` with the state stored for `index`, and queues `hashchange` if only the fragment changed. Rust never fires `hashchange`. |
| `onUnhandledRejection(promise, reason)` | end of a task, after the microtask checkpoint. JS fires the cancelable `unhandledrejection` and logs `Uncaught (in promise) …` unless it was canceled. Rust does not log when this hook is registered. |
| `onRejectionHandled(promise, reason)` | queued as a task. JS fires `rejectionhandled`. |
| `onError(msg, file, line, col, error)` | an uncaught exception reached Rust, which already logged it. JS dispatches the window `ErrorEvent` (`window.onerror`) and does not log. Not used for `N.evalScript`: JS catches the rethrown exception and dispatches the event itself. |
| `onWebSocket(id, kind, ...)` | an event of a socket opened with `N.wsOpen`, in order: `open` (protocol, extensions), `message` (string or ArrayBuffer), `sent` (bytes written, for `bufferedAmount`), `error` (message) and finally `close` (code, reason, wasClean). |

### `onEvent`: return flag 4 and the default-action split
Return value: `1` = canceled, `2` = propagation stopped, **`4` = the JS layer performed the
default/activation behaviour itself, so Rust must not run its own**.

* **JS does it and returns 4:**
  * **Click on a checkbox or radio.** Legacy pre-activation happens inside JS's dispatch, so Rust must not toggle anything before calling `onEvent`. After dispatch JS fires `input` and `change`; on a canceled click it restores the old state.
  * **Click on a `<label>`.** JS focuses the control and forwards the click to it.
  * **Click on a submit or reset button**, including `<input type=image>`. JS runs constraint validation, fires `submit` (a SubmitEvent), then calls `N.submitForm`, or does the reset.
  * **Click on a `<summary>`.** JS toggles the parent `<details>` `open` attribute and fires `toggle`.
  * **Click on a `javascript:` hyperlink.** JS runs the script.
  * **Not-canceled `keydown` Enter in a text-like `<input>` that has a form owner.** JS does implicit submission.
* **Rust does it when the event was not canceled and flag 4 is not set:**
  * following `<a>`/`<area>` hyperlinks (target and modifier keys)
  * pickers for file/color/date inputs
  * text editing and caret
  * focus on pointerdown
  * scrolling and Tab navigation
  * keyboard activation (Enter/Space become a trusted `click` through `onEvent`)
  * `change` on blur for edited text controls
* **Synthetic clicks** (`el.click()`, `dispatchEvent(new MouseEvent('click'))`): JS performs activation. It calls `N.runDefaultAction(id, "click")` only for untrusted clicks on hyperlinks and on file/color/date inputs.
* **New `init` field:** `submitterId` on `submit` becomes `SubmitEvent.submitter` (like `relatedTargetId` → `relatedTarget`). `submit` gets SubmitEvent, `toggle`/`beforetoggle` get ToggleEvent.

### Focus
`N.focus`/`N.blur` may dispatch `blur`/`focusout`/`focus`/`focusin` synchronously through
`onEvent`, as the Rust natives do. JS counts focus events that arrive during the call and fires
them itself only if none arrived. `N.activeElement()` must reflect the change immediately.

### Load-time purity (startup snapshot)
While the layer files run, JS calls only these natives: `documentId`, `setHooks`, `log`, `urlParse`,
`urlSet`, `textEncode`, `textDecode`, `structuredClone`, `cssSupports`, `compileFunction`
(`typeof` probes are fine). It never calls `Date.now`/`Math.random`, and no Map/Set/WeakMap/WeakSet
keyed by `globalThis` survives the load. Page-specific values are read lazily. `js/test` enforces this
(`00_smoke.test.js`).

### Other behaviour the layer relies on
* **Timers:** `N.setTimer` callbacks with equal due times fire in registration order (FIFO). 0 ms timers are the JS task queue.
* **Microtasks:** there is a microtask checkpoint after every hook invocation.
* **Node ids:** never reused. JS caches wrappers by id for the page's lifetime and does not call `N.releaseNode`.
* **`pathIds`:** run from the target up to and including the document. JS appends `window`.
* **Id kinds:** `querySelector(All)`, `innerHTML`, `textContent` and `childIds` accept document and fragment ids.
* **`setInnerHTML`** works on detached elements. JS parses table/select/template-context fragments through a detached context element.
* **`<style>`** text changes made through `setText`, `setTextContent` or child insertion re-parse the sheet.
* **DocumentType nodes** are native Comment nodes that JS types as 10. The main document gets one as its first child at `onDocumentParsed`, so the document can have a comment child before `<html>`.
* **Selector matching** uses live state: `:checked` (options included), `:indeterminate`, `:disabled`, `:focus`, and so on.
* **`N.evalScript`:** Rust logs the exception and rethrows. JS dispatches the `ErrorEvent` without logging.
* **Same-document navigations started from JS** (`location.hash`, `location.href = '#x'`): JS does them itself with `N.historyPush` plus `N.scrollIntoView`/`N.scrollTo`. `N.navigate` is only used for cross-document navigations.
