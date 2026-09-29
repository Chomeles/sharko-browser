//! Where the placeholder of a single-line `<input>` is painted, end to end: centered in the
//! content box like the value is (an empty editor layout has no height, so the offset that
//! centers the text used to be that of a zero-height line and pushed the placeholder down).

use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};
use common::display_list::{DisplayListRecorder, ResourceCache, SentResources};
use engine::raster::rasterize;

const WIDTH: u32 = 200;
const HEIGHT: u32 = 100;

/// Rows (first, last) of `y_range` that have ink (anything not white) in the columns `x_range`.
fn ink_rows(
    doc: &mut HtmlDocument,
    x_range: std::ops::Range<usize>,
    y_range: std::ops::Range<usize>,
) -> Option<(usize, usize)> {
    doc.resolve(0.0);
    let mut sent = SentResources::default();
    let mut recorder = DisplayListRecorder::new(&mut sent);
    blitz_paint::paint_scene(&mut recorder, doc, 1.0, WIDTH, HEIGHT, 0, 0);
    let mut list = recorder.finish();
    let mut cache = ResourceCache::default();
    cache.ingest(&mut list);
    let rgba = rasterize(&list, &cache, WIDTH, HEIGHT);
    let has_ink = |y: usize| {
        x_range.clone().any(|x| {
            let i = (y * WIDTH as usize + x) * 4;
            rgba[i..i + 3] != [255, 255, 255]
        })
    };
    let rows: Vec<usize> = y_range.filter(|&y| has_ink(y)).collect();
    Some((*rows.first()?, *rows.last()?))
}

fn document(inputs: &str) -> HtmlDocument {
    let html = format!("<!DOCTYPE html><html><body style='margin:0'>{inputs}</body></html>");
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(WIDTH, HEIGHT, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    doc
}

/// An input `height`px tall without border and padding, so that its content box is that tall.
fn input(attrs: &str, height: u32) -> String {
    format!(
        "<input {attrs} style='display:block;box-sizing:border-box;margin:0;border:0;\
         padding:0 4px;width:100px;height:{height}px;font:16px sans-serif;background:#fff'>"
    )
}

#[test]
fn a_placeholder_is_centered_like_a_value() {
    for height in [24, 40, 60] {
        let mut with_value = document(&input("value='Suche'", height));
        let mut with_placeholder = document(&input("placeholder='Suche'", height));
        let rows = 0..height as usize;
        let Some(value_rows) = ink_rows(&mut with_value, 0..100, rows.clone()) else {
            eprintln!("skipping: no usable font (the text has no ink)");
            return;
        };
        let placeholder_rows = ink_rows(&mut with_placeholder, 0..100, rows).unwrap();
        // The placeholder is dimmer than the value (as in browsers) but at the same height.
        assert_eq!(placeholder_rows, value_rows, "input {height}px tall");
        let middle = (value_rows.0 + value_rows.1) as f64 / 2.0;
        assert!(
            (middle - height as f64 / 2.0).abs() < 4.0,
            "{middle} in {height}px"
        );
    }
}

#[test]
fn a_placeholder_is_not_pushed_out_of_a_box_of_its_line_height() {
    // `line-height` as tall as the box: the placeholder used to start half a box too low.
    let html = "<input placeholder='Suche' style='display:block;box-sizing:border-box;margin:0;\
                border:0;padding:0 4px;width:100px;height:40px;font:16px/40px sans-serif;\
                background:#fff'>";
    let mut doc = document(html);
    let Some((first, last)) = ink_rows(&mut doc, 0..100, 0..40) else {
        eprintln!("skipping: no usable font (the text has no ink)");
        return;
    };
    assert!(first > 8 && last < 32, "ink in rows {first}..={last} of 40");
}
