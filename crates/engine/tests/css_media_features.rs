//! Media Queries 5 features the servo build of Stylo lacked: the query must be valid and
//! match like in a desktop browser without user preferences.

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

fn matches(query: &str) -> bool {
    let html = format!(
        "<!DOCTYPE html><style>body{{margin:0}}div{{width:50px;height:50px;background:#00f}}\
         @media {query}{{div{{background:#f00}}}}</style><div></div>"
    );
    pixel_at(&html, 10, 10) == [255, 0, 0]
}

#[test]
fn features_match_a_desktop_browser_without_preferences() {
    for q in [
        "(prefers-reduced-motion: no-preference)",
        "(scripting: enabled)",
        "(scripting)",
        "(forced-colors: none)",
        "(prefers-contrast: no-preference)",
        "(update: fast)",
        "(color-gamut: srgb)",
        "(display-mode: browser)",
    ] {
        assert!(matches(q), "{q}");
    }
}

#[test]
fn other_values_do_not_match() {
    for q in [
        "(prefers-reduced-motion: reduce)",
        "(prefers-reduced-motion)",
        "(scripting: none)",
        "(scripting: initial-only)",
        "(forced-colors: active)",
        "(prefers-contrast: more)",
        "(update: slow)",
        "(color-gamut: p3)",
        "(display-mode: standalone)",
    ] {
        assert!(!matches(q), "{q}");
    }
}
