//! `content-visibility: hidden` (CSS Containment 2 §4.1): the box stays, its contents get no
//! boxes.

use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, ResourceCache, SentResources};
use engine::raster::rasterize;

const SIZE: u32 = 100;

fn pixel_at(html: &str, x: usize, y: usize) -> [u8; 3] {
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(SIZE, SIZE, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    let mut sent = SentResources::default();
    let mut recorder = DisplayListRecorder::new(&mut sent);
    blitz_paint::paint_scene(&mut recorder, &mut doc, 1.0, SIZE, SIZE, 0, 0);
    let mut list = recorder.finish();
    let mut cache = ResourceCache::default();
    cache.ingest(&mut list);
    let rgba = rasterize(&list, &cache, SIZE, SIZE);
    let i = (y * SIZE as usize + x) * 4;
    [rgba[i], rgba[i + 1], rgba[i + 2]]
}

#[test]
fn hidden_contents_take_no_space_and_paint_nothing() {
    let html = "<!DOCTYPE html><style>body{margin:0}\
        .h{content-visibility:hidden;background:#00f}\
        .h div{height:60px;background:#f00}\
        .h::before{content:'';display:block;height:60px;background:#f00}\
        .after{height:100px;background:#0f0}</style>\
        <div class=h><div></div></div><div class=after></div>";
    // The skipped subtree (child and ::before) is absent, so the next block starts at 0.
    assert_eq!(pixel_at(html, 10, 10), [0, 255, 0]);
}

#[test]
fn visible_content_is_unaffected() {
    let html = "<!DOCTYPE html><style>body{margin:0}\
        .v{content-visibility:visible}.v div{height:60px;background:#f00}</style>\
        <div class=v><div></div></div>";
    assert_eq!(pixel_at(html, 10, 10), [255, 0, 0]);
}
