//! Which `<style>` elements apply and in what order (HTML §4.2.6, CSS Cascade 4 §6.4.1),
//! end to end: what the page paints, for style elements that script creates and inserts.

use blitz_dom::{DocumentConfig, NodeId, qual_name};
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


const PAGE: &str = "<!DOCTYPE html><html><head><style id='late'>.x{background:#00f}</style></head>\
    <body style='margin:0'><div class='x' style='height:20px'></div></body></html>";

fn new_style(doc: &mut HtmlDocument, css: &str) -> NodeId {
    let mut m = doc.mutate();
    let style = m.create_element(qual_name!("style"), vec![]);
    let text = m.create_text_node(css);
    m.append_children(style, &[text]);
    style
}

#[test]
fn a_style_inserted_before_an_older_one_loses_to_it() {
    // Author sheets cascade in tree order, not in creation order (emotion's `prepend`).
    let mut doc = document(PAGE);
    let early = new_style(&mut doc, ".x{background:#f00}");
    let late = doc.get_element_by_id("late").unwrap();
    doc.mutate().insert_nodes_before(late, &[early]);
    assert_eq!(pixel_at(&mut doc, 10, 10), BLUE);

    // ... and one appended after it wins.
    let mut doc = document(PAGE);
    let after = new_style(&mut doc, ".x{background:#f00}");
    let head = doc.get_node(late_id(&doc)).unwrap().parent.unwrap();
    doc.mutate().append_children(head, &[after]);
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
}

fn late_id(doc: &HtmlDocument) -> NodeId {
    doc.get_element_by_id("late").unwrap()
}

#[test]
fn a_detached_style_does_not_apply() {
    let mut doc = document(PAGE);
    let detached = new_style(&mut doc, ".x{background:#f00}");
    assert_eq!(pixel_at(&mut doc, 10, 10), BLUE);
    // Inserted, it applies (it follows the page's sheet); removed, it stops.
    let head = doc.get_node(late_id(&doc)).unwrap().parent.unwrap();
    doc.mutate().append_children(head, &[detached]);
    assert_eq!(pixel_at(&mut doc, 10, 10), RED);
    doc.mutate().remove_node(detached);
    assert_eq!(pixel_at(&mut doc, 10, 10), BLUE);
}
