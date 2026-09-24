use anyrender::ImageRenderer;
use anyrender_vello_cpu::VelloCpuImageRenderer;
use blitz_dom::DocumentConfig;
use blitz_html::HtmlDocument;
use blitz_traits::shell::{ColorScheme, Viewport};

pub fn render_html_to_rgba(html: &str, base_url: &str, width: u32, height: u32) -> (Vec<u8>, u32) {
    let t0 = std::time::Instant::now();
    let config = DocumentConfig {
        base_url: Some(base_url.to_string()),
        viewport: Some(Viewport::new(width, height, 1.0, ColorScheme::Light)),
        ..Default::default()
    };
    let mut doc = HtmlDocument::from_html(html, config);
    let t1 = t0.elapsed();
    doc.resolve(0.0);
    let t2 = t0.elapsed();
    let root_h = doc.root_element().final_layout().size.height as u32;
    let h = height.max(root_h).min(8000);
    let mut sent = common::display_list::SentResources::default();
    let mut rec = common::display_list::DisplayListRecorder::new(&mut sent);
    blitz_paint::paint_scene(&mut rec, &mut doc, 1.0, width, h, 0, 0);
    let list = rec.finish();
    let t3 = t0.elapsed();
    let bytes = postcard::to_allocvec(&list).unwrap();
    let mut list2: common::display_list::DisplayList = postcard::from_bytes(&bytes).unwrap();
    let t4 = t0.elapsed();
    let mut cache = common::display_list::ResourceCache::default();
    cache.ingest(&mut list2);
    let mut buf = Vec::new();
    let mut renderer = VelloCpuImageRenderer::new(width, h);
    renderer.render_to_vec(
        |scene| common::display_list::replay(&list2, &cache, scene, kurbo::Affine::IDENTITY),
        &mut buf,
    );
    let t5 = t0.elapsed();
    eprintln!("parse {:?} resolve {:?} paint {:?} ({} cmds) ser+de {:?} ({} bytes) raster {:?}", t1, t2 - t1, t3 - t2, list.cmds.len(), t4 - t3, bytes.len(), t5 - t4);
    (buf, h)
}

pub fn write_png(path: &str, rgba: &[u8], w: u32, h: u32) {
    let file = std::fs::File::create(path).unwrap();
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    let mut writer = enc.write_header().unwrap();
    writer.write_image_data(rgba).unwrap();
}
