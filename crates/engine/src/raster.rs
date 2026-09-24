//! CPU rasterization of display lists with vello_cpu (SIMD + multithreaded) and PNG output.

use anyrender::{ImageRenderer, PaintScene};
use anyrender_vello_cpu::VelloCpuImageRenderer;
use common::display_list::{DisplayList, ResourceCache, replay};
use kurbo::{Affine, Rect};
use peniko::{Color, Fill};

/// Rasterize `list` into an RGBA8 buffer of `width` x `height` physical pixels, on a
/// white background (the canvas colour when the page doesn't set one).
pub fn rasterize(list: &DisplayList, cache: &ResourceCache, width: u32, height: u32) -> Vec<u8> {
    let mut buf = Vec::with_capacity((width * height * 4) as usize);
    let mut renderer = VelloCpuImageRenderer::new(width, height);
    renderer.render_to_vec(
        |scene| {
            scene.fill(
                Fill::NonZero,
                Affine::IDENTITY,
                Color::WHITE,
                None,
                &Rect::new(0.0, 0.0, width as f64, height as f64),
            );
            replay(list, cache, scene, Affine::IDENTITY);
        },
        &mut buf,
    );
    buf
}

/// Encode RGBA8 pixels as PNG.
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> std::io::Result<Vec<u8>> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, width, height);
        enc.set_color(png::ColorType::Rgba);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(std::io::Error::other)?;
        w.write_image_data(rgba).map_err(std::io::Error::other)?;
    }
    Ok(out)
}
