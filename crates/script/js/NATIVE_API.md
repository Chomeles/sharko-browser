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
