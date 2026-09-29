//! `content: "x" / "alt"` (CSS Generated Content 3 §2.1): the declaration is valid, so the
//! `::before` box exists; only the items before the slash are laid out.

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

fn page(content: &str) -> String {
    format!(
        "<!DOCTYPE html><style>body{{margin:0}}div::before{{content:{content};display:block;\
         width:50px;height:50px;background:#f00;font-size:1px}}</style><div></div>"
    )
}

#[test]
fn content_with_alt_text_generates_the_box() {
    for content in [r#""" / """#, r#""\e902" / """#, r#""x" / "alt""#, r#""x" / attr(title)"#] {
        assert_eq!(pixel_at(&page(content), 10, 10), [255, 0, 0], "{content}");
    }
}

#[test]
fn content_none_generates_no_box() {
    assert_eq!(pixel_at(&page("none"), 10, 10), [255, 255, 255]);
}
