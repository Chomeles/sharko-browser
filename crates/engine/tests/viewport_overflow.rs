//! Overflow propagation to the viewport (CSS Overflow 3 §3.3), end to end: what the page
//! paints. The layout and scrolling side is tested in blitz-dom (`viewport_overflow.rs`).

use blitz_dom::{DocumentConfig, ScrollBehavior};
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, ResourceCache, SentResources};
use engine::raster::rasterize;

const WIDTH: u32 = 100;
const HEIGHT: u32 = 100;

fn document(html: &str) -> HtmlDocument {
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
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

const RED: [u8; 3] = [255, 0, 0];
const BLUE: [u8; 3] = [0, 0, 255];
const WHITE: [u8; 3] = [255, 255, 255];

/// A 20px tall body with a red 500px block: what overflows the body shows unless it clips.
fn short_body(html_style: &str, body_style: &str) -> String {
    format!(
        "<!DOCTYPE html><html style='height:100%;{html_style}'>\
         <body style='margin:0;height:20px;{body_style}'>\
         <div style='height:500px;background:#f00'></div></body></html>"
    )
}

#[test]
fn the_body_whose_overflow_the_viewport_took_does_not_clip() {
    for overflow in ["hidden", "auto", "scroll"] {
        let mut doc = document(&short_body("", &format!("overflow:{overflow}")));
        assert_eq!(pixel_at(&mut doc, 10, 10), RED, "{overflow}");
        assert_eq!(pixel_at(&mut doc, 10, 60), RED, "{overflow}");
    }
}

#[test]
fn a_body_with_an_overflow_of_its_own_clips() {
    // The root element's overflow is the viewport's: the body keeps its own.
    let mut doc = document(&short_body("overflow:hidden", "overflow:hidden"));
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(pixel_at(&mut doc, 10, 60), WHITE);

    // Containment stops the propagation.
    let mut doc = document(&short_body("", "overflow:hidden;contain:paint"));
    assert_eq!(pixel_at(&mut doc, 10, 60), WHITE);
}

#[test]
fn the_viewport_scrolls_the_page_of_a_body_with_a_definite_height() {
    let mut doc = document(
        "<!DOCTYPE html><html style='height:100%'>\
         <body style='margin:0;height:100%;overflow:auto'>\
         <div style='height:300px;background:#f00'></div>\
         <div style='height:300px;background:#00f'></div></body></html>",
    );
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);

    // The viewport is scrolled (also with the body locked by `overflow: hidden`, by script).
    let root = doc.root_element().id;
    doc.scroll_to(root, 0.0, 400.0, ScrollBehavior::Instant);
    assert_eq!(doc.viewport_scroll().y, 400.0);
    assert_eq!(pixel_at(&mut doc, 10, 10), BLUE);
    assert_eq!(pixel_at(&mut doc, 10, 90), BLUE);

    let body = doc.get_node(root).unwrap().children[1];
    doc.mutate().set_style_property(body, "overflow", "hidden");
    doc.scroll_to(root, 0.0, 250.0, ScrollBehavior::Instant);
    assert_eq!(doc.viewport_scroll().y, 250.0);
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    assert_eq!(pixel_at(&mut doc, 10, 90), BLUE);
}
