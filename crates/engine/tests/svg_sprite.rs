//! Icons from SVG sprites, end to end: what the page paints. `<use href="sprite.svg#icon">`
//! names an element of another document (SVG 2 §5.6.2), which is fetched (same-origin only)
//! and drawn where the `<use>` is; `xlink:href` (parsed or set by script) does the same as
//! `href`. The sprite is served by a stub network that can hold the response back.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use blitz_dom::{Attribute, DocumentConfig, LocalName, QualName, ns};
use blitz_html::HtmlDocument;
use blitz_traits::net::{Bytes, NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, ResourceCache, SentResources};
use engine::raster::rasterize;

const WIDTH: u32 = 100;
const HEIGHT: u32 = 100;
const PAGE: &str = "http://example.test/dir/page.html";

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const GREEN: [u8; 3] = [0, 255, 0];
const WHITE: [u8; 3] = [255, 255, 255];

/// A sprite as icon generators write it: symbols in `<defs>`, a gradient one of them uses,
/// a symbol that uses another, and a `<style>` sheet.
const SPRITE: &str = r##"<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<defs>
<symbol id="sq" viewBox="0 0 10 10"><rect width="10" height="10" fill="currentColor"/></symbol>
<linearGradient id="g"><stop offset="0" stop-color="#00f"/><stop offset="1" stop-color="#00f"/></linearGradient>
<symbol id="grad" viewBox="0 0 10 10"><rect width="10" height="10" fill="url(#g)"/></symbol>
<symbol id="nest" viewBox="0 0 10 10"><use xlink:href="#sq"/></symbol>
</defs>
<style>.green { fill: #0f0 }</style>
<symbol id="cls" viewBox="0 0 10 10"><rect class="green" width="10" height="10"/></symbol>
</svg>"##;

/// Serves `files` (URL to body); requests for anything else fail. With `hold` set, the
/// responses wait for `release`.
#[derive(Default)]
struct Net {
    files: HashMap<String, &'static str>,
    requested: Mutex<Vec<String>>,
    hold: Mutex<Option<Vec<(String, Box<dyn NetHandler>)>>>,
}

impl Net {
    fn serving(files: &[(&str, &'static str)]) -> Arc<Self> {
        Arc::new(Self {
            files: files.iter().map(|(u, b)| (u.to_string(), *b)).collect(),
            ..Default::default()
        })
    }

    fn requested(&self) -> Vec<String> {
        self.requested.lock().unwrap().clone()
    }

    fn deliver(&self, url: String, handler: Box<dyn NetHandler>) {
        if let Some(body) = self.files.get(&url) {
            handler.bytes(url, Bytes::from_static(body.as_bytes()));
        }
    }

    fn release(&self) {
        for (url, handler) in self.hold.lock().unwrap().take().unwrap_or_default() {
            self.deliver(url, handler);
        }
    }
}

impl NetProvider for Net {
    fn fetch(&self, _doc_id: usize, request: Request, handler: Box<dyn NetHandler>) {
        let url = request.url.to_string();
        self.requested.lock().unwrap().push(url.clone());
        match self.hold.lock().unwrap().as_mut() {
            Some(held) => held.push((url, handler)),
            None => self.deliver(url, handler),
        }
    }
}

fn document(net: &Arc<Net>, body: &str) -> HtmlDocument {
    let html = format!("<!DOCTYPE html><html><body style='margin:0'>{body}</body></html>");
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
            base_url: Some(PAGE.to_string()),
            net_provider: Some(net.clone()),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    doc
}

/// The RGB of the pixel (x, y) of the painted viewport.
fn pixel_at(doc: &mut HtmlDocument, x: usize, y: usize) -> [u8; 3] {
    doc.resolve(0.0);
    let mut sent = SentResources::default();
    let mut recorder = DisplayListRecorder::new(&mut sent);
    blitz_paint::paint_scene(&mut recorder, doc, 1.0, WIDTH, HEIGHT, 0, 0);
    let mut list = recorder.finish();
    let mut cache = ResourceCache::default();
    cache.ingest(&mut list);
    let rgba = rasterize(&list, &cache, WIDTH, HEIGHT);
    let i = (y * WIDTH as usize + x) * 4;
    [rgba[i], rgba[i + 1], rgba[i + 2]]
}

/// A 20px icon that uses `href` (an attribute as authored: `href="…"` or `xlink:href="…"`).
fn icon(uses: &str) -> String {
    format!("<svg width='20' height='20' style='color:#f00'><use {uses}></use></svg>")
}

#[test]
fn a_use_of_an_external_sprite_draws_the_element_with_the_current_color() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    let mut doc = document(&net, &icon("href='sprite.svg#sq'"));
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(pixel_at(&mut doc, 30, 10), WHITE);
    assert_eq!(net.requested(), ["http://example.test/dir/sprite.svg"]);
}

#[test]
fn xlink_href_and_root_relative_urls_resolve_like_href() {
    let net = Net::serving(&[("http://example.test/sprite.svg", SPRITE)]);
    let mut doc = document(&net, &icon("xlink:href='/sprite.svg#sq'"));
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
}

#[test]
fn the_sprite_is_fetched_once_and_shared_by_all_uses() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    let body = format!(
        "{}{}{}",
        icon("href='sprite.svg#sq'"),
        icon("href='sprite.svg#grad'"),
        icon("href='sprite.svg#cls'")
    );
    let mut doc = document(&net, &format!("<div style='display:flex'>{body}</div>"));
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(pixel_at(&mut doc, 30, 10), BLUE);
    assert_eq!(pixel_at(&mut doc, 50, 10), GREEN);
    assert_eq!(net.requested().len(), 1);
}

#[test]
fn what_an_element_of_the_sprite_uses_comes_along() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    // `#grad` fills with a gradient of the sprite, `#nest` uses `#sq`.
    let mut doc = document(&net, &icon("href='sprite.svg#grad'"));
    assert_eq!(pixel_at(&mut doc, 10, 10), BLUE);
    let mut doc = document(&net, &icon("href='sprite.svg#nest'"));
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
}

#[test]
fn the_ids_of_a_sprite_do_not_shadow_those_of_the_page() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    // The page has its own `sq` (green) that its own `<use>` draws next to the sprite's.
    let page_symbol = "<svg style='display:none'><symbol id='sq' viewBox='0 0 10 10'>\
                       <rect width='10' height='10' fill='#0f0'/></symbol></svg>";
    let body = format!(
        "{page_symbol}<div style='display:flex'>{}<svg width='20' height='20'>\
         <use href='#sq'></use></svg></div>",
        icon("href='sprite.svg#sq'")
    );
    let mut doc = document(&net, &body);
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(pixel_at(&mut doc, 30, 10), GREEN);
}

#[test]
fn the_icon_appears_when_the_sprite_arrives() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    *net.hold.lock().unwrap() = Some(Vec::new());
    let mut doc = document(&net, &icon("href='sprite.svg#sq'"));
    assert_eq!(pixel_at(&mut doc, 10, 10), WHITE);
    net.release();
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(net.requested().len(), 1);
}

#[test]
fn a_sprite_of_another_origin_is_not_fetched() {
    let net = Net::serving(&[
        ("http://cdn.test/sprite.svg", SPRITE),
        ("https://example.test/dir/sprite.svg", SPRITE),
    ]);
    for href in [
        "http://cdn.test/sprite.svg#sq",
        "https://example.test/dir/sprite.svg#sq",
    ] {
        let mut doc = document(&net, &icon(&format!("href='{href}'")));
        assert_eq!(pixel_at(&mut doc, 10, 10), WHITE, "{href}");
    }
    assert_eq!(net.requested(), Vec::<String>::new());
}

#[test]
fn a_missing_element_or_document_draws_nothing() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    for href in ["sprite.svg#nope", "sprite.svg", "gone.svg#sq"] {
        let mut doc = document(&net, &icon(&format!("href='{href}'")));
        assert_eq!(pixel_at(&mut doc, 10, 10), WHITE, "{href}");
    }
}

#[test]
fn a_sprite_that_is_no_svg_is_not_asked_for_again() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", "<html>nope</html>")]);
    let body = format!(
        "{}{}",
        icon("href='sprite.svg#a'"),
        icon("href='sprite.svg#b'")
    );
    let mut doc = document(&net, &body);
    assert_eq!(pixel_at(&mut doc, 10, 10), WHITE);
    assert_eq!(net.requested().len(), 1);
}

#[test]
fn the_page_url_with_a_fragment_is_a_reference_into_the_page() {
    let net = Net::serving(&[]);
    let symbol = "<svg style='display:none'><symbol id='s' viewBox='0 0 10 10'>\
                  <rect width='10' height='10' fill='currentColor'/></symbol></svg>";
    let body = format!("{symbol}{}", icon(&format!("href='{PAGE}#s'")));
    let mut doc = document(&net, &body);
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(net.requested(), Vec::<String>::new());
}

/// HTML parsing gives `xlink:href` no namespace declaration in the markup usvg reads.
#[test]
fn xlink_href_of_a_symbol_in_the_page_is_followed() {
    let net = Net::serving(&[]);
    let symbol = "<svg style='display:none'><symbol id='s' viewBox='0 0 10 10'>\
                  <rect width='10' height='10' fill='currentColor'/></symbol></svg>";
    let mut doc = document(&net, &format!("{symbol}{}", icon("xlink:href='#s'")));
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
}

/// A script's `setAttributeNS(xlink, "xlink:href", …)` leaves the attribute with the whole
/// qualified name as its local name, and the `<svg>` is built from parts that are
/// appended to the page afterwards (Vue, React).
#[test]
fn a_use_built_by_script_with_xlink_href_draws_the_sprite() {
    let net = Net::serving(&[("http://example.test/dir/sprite.svg", SPRITE)]);
    let mut doc = document(&net, "");
    let body = doc.query_selector("body").unwrap().unwrap();
    let svg_name = |local: &str| QualName::new(None, ns!(svg), LocalName::from(local));
    let attr = |name: &str, value: &str| Attribute {
        name: QualName::new(None, ns!(), LocalName::from(name)),
        value: value.to_string(),
    };
    let mut mutator = doc.mutate();
    let svg = mutator.create_element(
        svg_name("svg"),
        vec![
            attr("width", "20"),
            attr("height", "20"),
            attr("style", "color:#f00"),
        ],
    );
    let use_ = mutator.create_element(
        svg_name("use"),
        vec![attr("xlink:href", "/dir/sprite.svg#sq")],
    );
    mutator.append_children(svg, &[use_]);
    mutator.append_children(body, &[svg]);
    drop(mutator);
    // The first pass builds the `<svg>` and requests the sprite, the next one has it.
    doc.resolve(0.0);
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
}
