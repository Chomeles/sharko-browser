//! `background-clip: text` (CSS Backgrounds 4 §3.7): the background shows through the glyphs
//! only. Without it a `color: transparent` gradient heading painted a plain rectangle.

use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, ResourceCache, SentResources};
use engine::raster::rasterize;

const SIZE: u32 = 100;

/// (green pixels, white pixels) of the rendered page.
fn count(html: &str) -> (usize, usize) {
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
    let mut green = 0;
    let mut white = 0;
    for p in rgba.chunks(4) {
        match [p[0], p[1], p[2]] {
            [0, 128, 0] => green += 1,
            [255, 255, 255] => white += 1,
            _ => {}
        }
    }
    (green, white)
}

fn page(style: &str, inner: &str) -> String {
    format!(
        "<!DOCTYPE html><style>body{{margin:0}}h1{{margin:0;font:bold 90px sans-serif;\
         color:transparent;background:green;{style}}}</style><h1>{inner}</h1>"
    )
}

#[test]
fn background_shows_only_through_the_glyphs() {
    let (green, white) = count(&page("background-clip:text", "HI"));
    assert!(green > 200, "glyph pixels get the background: {green}");
    assert!(white > 5000, "the rest of the box stays empty: {white}");
}

#[test]
fn webkit_prefix_is_an_alias() {
    let (green, white) = count(&page("-webkit-background-clip:text", "HI"));
    assert!(green > 200 && white > 5000, "{green} {white}");
}

#[test]
fn descendant_text_is_part_of_the_clip() {
    let (green, white) = count(&page("background-clip:text", "<span>H</span>I"));
    assert!(green > 200 && white > 5000, "{green} {white}");
}

#[test]
fn without_clip_text_the_box_is_filled() {
    let (green, _) = count(&page("", "HI"));
    assert!(green > 5000, "{green}");
}
