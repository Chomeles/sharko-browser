//! `:lang()` (Selectors 4 §8.1) and `:dir()` (§8.2): the language / direction is inherited,
//! `:lang` uses RFC 4647 extended filtering.

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

/// Whether `selector` matches the `<p>` inside `wrapper` (painted red when it does).
fn matches(wrapper: &str, selector: &str) -> bool {
    let html = format!(
        "<!DOCTYPE html><style>body{{margin:0}}p{{margin:0;width:50px;height:50px;background:#00f}}\
         p{selector}{{background:#f00}}</style>{wrapper}"
    );
    pixel_at(&html, 10, 10) == [255, 0, 0]
}

#[test]
fn lang_is_inherited_and_prefix_matched() {
    let w = "<div lang='en-GB'><p></p></div>";
    assert!(matches(w, ":lang(en)"));
    assert!(matches(w, ":lang(en-GB)"));
    assert!(matches(w, ":lang(en-gb)"));
    assert!(matches(w, ":lang('*-GB')"));
    assert!(!matches(w, ":lang(de)"));
    assert!(!matches(w, ":lang(en-US)"));
}

#[test]
fn the_closest_lang_wins_and_no_lang_matches_nothing() {
    assert!(matches("<div lang='de'><p lang='en'></p></div>", ":lang(en)"));
    assert!(!matches("<div lang='en'><p lang='de'></p></div>", ":lang(en)"));
    assert!(!matches("<div><p></p></div>", ":lang(en)"));
    assert!(matches("<div><p></p></div>", ":not(:lang(en))"));
}
