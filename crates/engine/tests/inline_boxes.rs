//! Inline-blocks under `white-space: nowrap` and inline elements around blocks, against
//! the boxes Chromium lays out (measured on the same markup).

use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

fn document(html: &str) -> HtmlDocument {
    let mut doc = HtmlDocument::from_html(
        html,
        DocumentConfig {
            viewport: Some(Viewport::new(1000, 600, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    doc
}

fn width(doc: &HtmlDocument, id: &str) -> f32 {
    let node = doc.get_element_by_id(id).unwrap();
    doc.get_node(node).unwrap().final_layout().size.width
}

const CAROUSEL: &str = "<!DOCTYPE html><style>body{margin:0;font:13px Arial}\
    ul{margin:0;padding:0;list-style:none}\
    #pane{white-space:nowrap;overflow-x:scroll;width:400px}\
    .grp{display:inline-block}\
    .t{display:inline-block;vertical-align:top;width:100px;height:40px;white-space:normal}\
    </style>\
    <ul id=pane><li class=grp id=g><ul><li class=t id=t1><a id=a1 href=#>\
    <span id=s1><h2 id=h1 style='margin:0;font-size:13px'>One</h2></span></a></li>\
    <li class=t></li><li class=t></li><li class=t></li><li class=t></li><li class=t></li>\
    </ul></li></ul>";

#[test]
fn inline_boxes_without_text_honour_nowrap_in_the_min_content_width() {
    // Six 100px tiles under `nowrap` are one 600px row, not 400px (the pane) wrapped into two.
    let doc = document(CAROUSEL);
    assert_eq!(width(&doc, "g"), 600.0);
}

#[test]
fn an_inline_element_around_a_block_spans_the_block() {
    let doc = document(CAROUSEL);
    let node = doc.get_element_by_id("a1").unwrap();
    let r = doc.get_client_bounding_rect(node).unwrap();
    assert_eq!((r.x, r.width), (0.0, 100.0));
    assert!(r.height >= 15.0, "{}", r.height);
    let span = doc.get_client_bounding_rect(doc.get_element_by_id("s1").unwrap()).unwrap();
    assert_eq!(span.width, 100.0);
}
