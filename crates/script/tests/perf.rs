//! Performance smoke measurements (run with `cargo test -p script --release --test perf -- --nocapture --ignored`).

mod common;

use std::time::Instant;

use common::Env;

#[test]
#[ignore]
fn startup_and_native_throughput() {
    // Warm up V8 (first isolate in the process pays platform init).
    let _ = Env::new("<p>warm</p>");
    let t0 = Instant::now();
    let host = std::rc::Rc::new(common::MockHost::default());
    let rt = script::ScriptRuntime::new(host.clone(), common::options(Default::default(), true));
    let total = t0.elapsed();
    let stats = rt.startup_stats().clone();
    eprintln!(
        "runtime with JS layer: total {:?}, context setup {:?}, JS layer {:?} ({} files); errors: {:?}",
        total,
        stats.context_setup,
        stats.js_layer,
        stats.js_layer_files,
        host.errors()
    );
    eprintln!("per file: {:?}", stats.js_layer_per_file);
    let t0 = Instant::now();
    let rt2 = script::ScriptRuntime::new(host.clone(), common::options(Default::default(), true));
    eprintln!("second runtime in process: {:?}", t0.elapsed());
    drop(rt2);
    drop(rt);

    let mut body = String::new();
    for i in 0..2000 {
        body.push_str(&format!(
            "<div class=\"c{}\"><span>{i}</span></div>",
            i % 10
        ));
    }
    let mut e = Env::new(&format!("<html><body>{body}</body></html>"));
    e.eval("globalThis.N = __native; 1");
    let t = Instant::now();
    let r = e.eval(
        r#"
        let n = 0;
        const body = N.querySelector(N.documentId(), 'body');
        for (let k = 0; k < 100; k++) {
            let c = N.firstChild(body);
            while (c) { n += N.nodeType(c); c = N.nextSibling(c); }
        }
        n
    "#,
    );
    let el = t.elapsed();
    eprintln!(
        "200k sibling steps + 200k nodeType: {el:?} ({:.0} ns/call) -> {r}",
        el.as_nanos() as f64 / 400_000.0
    );
    let t = Instant::now();
    e.eval("for (let k = 0; k < 1000; k++) N.querySelectorAll(N.documentId(), '.c3 > span'); 1");
    eprintln!("1000x querySelectorAll over 4k elements: {:?}", t.elapsed());
    let t = Instant::now();
    e.eval("const d = N.querySelector(N.documentId(), 'div'); for (let k = 0; k < 10000; k++) { N.setAttr(d, 'data-k', String(k)); N.getAttr(d, 'data-k'); } 1");
    eprintln!("10k setAttr+getAttr: {:?}", t.elapsed());
    let t = Instant::now();
    e.eval("for (let k = 0; k < 1000; k++) { N.styleSet(d, 'width', k + 'px', ''); N.getBoundingClientRect(d); } 1");
    eprintln!("1000x style write + forced layout: {:?}", t.elapsed());
    let t = Instant::now();
    e.eval("for (let k = 0; k < 10000; k++) N.getBoundingClientRect(d); 1");
    eprintln!("10000x layout read (clean): {:?}", t.elapsed());
    let t = Instant::now();
    e.eval("const host = N.createElement('div', ''); for (let k = 0; k < 1000; k++) N.setInnerHTML(host, '<p>a<b>b</b></p><ul><li>1</li><li>2</li></ul>'); 1");
    eprintln!("1000x innerHTML set: {:?}", t.elapsed());
}

#[test]
#[ignore]
fn js_layer_compile_vs_run() {
    let _ = Env::new("<p>warm</p>");
    let mut e = Env::new("<p>x</p>");
    for name in [
        "00_prelude.js",
        "10_events.js",
        "20_dom.js",
        "30_html.js",
        "40_webapi.js",
        "90_bootstrap.js",
    ] {
        let path = format!("{}/js/{name}", env!("CARGO_MANIFEST_DIR"));
        let Ok(src) = std::fs::read_to_string(&path) else {
            continue;
        };
        let js = format!(
            "(() => {{ const src = {src:?}; const t0 = N.now(); const f = new Function(src); const t1 = N.now(); f(); const t2 = N.now(); return [t1 - t0, t2 - t1]; }})()",
            src = src
        );
        if name == "00_prelude.js" {
            e.eval("globalThis.N = __native; 1");
        }
        eprintln!("{name}: [compile ms, run ms] = {}", e.eval(&js));
    }
}

#[test]
#[ignore]
fn js_layer_define_property_census() {
    let _ = Env::new("<p>warm</p>");
    let mut e = Env::new("<p>x</p>");
    e.eval(
        r#"
        globalThis.N = __native;
        globalThis.__dp = { n: 0, t: 0, byProto: new Map() };
        const odp = Object.defineProperty;
        Object.defineProperty = function (o, k, d) {
            const t0 = N.now();
            const r = odp(o, k, d);
            __dp.t += N.now() - t0; __dp.n++;
            let name = (o && o.constructor && o.constructor.name) || typeof o;
            __dp.byProto.set(name, (__dp.byProto.get(name) || 0) + 1);
            return r;
        };
        1
    "#,
    );
    for name in ["00_prelude.js", "10_events.js", "20_dom.js"] {
        let path = format!("{}/js/{name}", env!("CARGO_MANIFEST_DIR"));
        let src = std::fs::read_to_string(&path).unwrap();
        let js = format!(
            "(() => {{ const t0 = N.now(); (new Function({src:?}))(); return N.now() - t0; }})()",
            src = src
        );
        eprintln!("{name}: {} ms", e.eval(&js));
    }
    eprintln!(
        "defineProperty calls: {}",
        e.eval("[__dp.n, __dp.t, [...__dp.byProto].sort((a,b)=>b[1]-a[1]).slice(0,12)]")
    );
}

#[test]
#[ignore]
fn selector_costs() {
    let mut body = String::new();
    for i in 0..2000 {
        body.push_str(&format!(
            "<div class=\"c{}\"><span>{i}</span></div>",
            i % 10
        ));
    }
    let mut e = Env::new(&format!("<html><body>{body}</body></html>"));
    e.eval("globalThis.N = __native; 1");
    for sel in [
        "span",
        ".c3",
        ".c3 > span",
        "#nope",
        "div span",
        "div:nth-child(2n+1) > span",
        "div:last-child",
        "div + div",
    ] {
        let js = format!(
            "(() => {{ const t0 = N.now(); let n = 0; for (let k = 0; k < 200; k++) n = N.querySelectorAll(N.documentId(), {sel:?}).length; const t1 = N.now(); for (let k = 0; k < 200; k++) N.querySelector(N.documentId(), {sel:?}); return [n, (t1 - t0) / 200, (N.now() - t1) / 200]; }})()"
        );
        eprintln!("{sel}: [matches, all ms, first ms] = {}", e.eval(&js));
    }
    let body_js = "(() => { const b = N.querySelector(N.documentId(), 'body'); const t0 = N.now(); for (let k = 0; k < 200; k++) N.querySelectorAll(b, 'span'); return (N.now() - t0) / 200; })()";
    eprintln!("scoped to body 'span': {} ms", e.eval(body_js));
}
