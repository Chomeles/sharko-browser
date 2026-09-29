//! Size container queries (CSS Conditional 5 §5, Containment 3), end to end: what the page
//! paints. Style needs container sizes from layout, so a failing invalidation loop shows as
//! the un-queried colour.

use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, ResourceCache, SentResources};
use engine::raster::rasterize;

const WIDTH: u32 = 400;
const HEIGHT: u32 = 100;

const RED: [u8; 3] = [255, 0, 0];
const GREEN: [u8; 3] = [0, 128, 0];
const WHITE: [u8; 3] = [255, 255, 255];

fn pixel_at(html: &str, x: usize, y: usize) -> [u8; 3] {
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    let mut sent = SentResources::default();
    let mut recorder = DisplayListRecorder::new(&mut sent);
    blitz_paint::paint_scene(&mut recorder, &mut doc, 1.0, WIDTH, HEIGHT, 0, 0);
    let mut list = recorder.finish();
    let mut cache = ResourceCache::default();
    cache.ingest(&mut list);
    let rgba = rasterize(&list, &cache, WIDTH, HEIGHT);
    let i = (y * WIDTH as usize + x) * 4;
    [rgba[i], rgba[i + 1], rgba[i + 2]]
}

/// A 20px tall red bar inside a container; `css` turns it green when its query matches.
fn page(css: &str, body: &str) -> String {
    format!(
        "<!DOCTYPE html><style>body{{margin:0}} .bar{{height:20px;background:#f00}} {css}</style>{body}"
    )
}

#[test]
fn width_queries_use_the_laid_out_container_size() {
    let css = ".c{container-type:inline-size;width:250px} \
               @container (width < 300px){.bar{background:#008000}} \
               @container (min-width: 300px){.bar{background:#00f}}";
    let html = page(css, "<div class=c><div class=bar></div></div>");
    assert_eq!(pixel_at(&html, 10, 10), GREEN);
}

#[test]
fn queries_without_a_container_ancestor_never_match() {
    let html = page(
        "@container (width < 300px){.bar{background:#008000}}",
        "<div><div class=bar></div></div>",
    );
    assert_eq!(pixel_at(&html, 10, 10), RED);
}

#[test]
fn container_names_and_the_shorthand_select_the_container() {
    let css = ".c{container:card/inline-size;width:250px} .d{container-type:inline-size;width:500px} \
               @container card (width < 300px){.bar{background:#008000}}";
    let html = page(css, "<div class=c><div class=d><div class=bar></div></div></div>");
    // The nearer `.d` is not named `card`: the query looks at `.c`.
    assert_eq!(pixel_at(&html, 10, 10), GREEN);
}

#[test]
fn nested_containers_settle_over_several_passes() {
    let css = ".o{container-type:inline-size;width:400px} \
               .i{container-type:inline-size;width:50%} \
               @container (min-width: 300px){.i{width:200px}} \
               @container (width = 200px){.bar{background:#008000}}";
    let html = page(css, "<div class=o><div class=i><div class=bar></div></div></div>");
    assert_eq!(pixel_at(&html, 10, 10), GREEN);
}

#[test]
fn container_query_length_units_resolve_against_the_container() {
    let css = ".c{container-type:inline-size;width:200px} .bar{width:50cqw;background:#008000}";
    let html = page(css, "<div class=c><div class=bar></div></div>");
    assert_eq!(pixel_at(&html, 50, 10), GREEN);
    assert_eq!(pixel_at(&html, 150, 10), WHITE);
}

#[test]
fn height_queries_need_a_size_container() {
    let css = "@container (height > 50px){.bar{background:#008000}} \
               .s{container-type:size;height:80px} .n{container-type:inline-size;height:80px}";
    let html = page(css, "<div class=s><div class=bar></div></div>");
    assert_eq!(pixel_at(&html, 10, 10), GREEN);
    // An inline-size container has no height axis to query.
    let html = page(css, "<div class=n><div class=bar></div></div>");
    assert_eq!(pixel_at(&html, 10, 10), RED);
}
