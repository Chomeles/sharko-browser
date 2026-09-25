//! Canvas 2D rasterization for `CanvasRenderingContext2D` (tiny-skia).
//!
//! The JS layer keeps the drawing state (styles, transform, current path, clip stack) and
//! calls these natives with paths already in device space; each `<canvas>` with a 2D
//! context has a premultiplied RGBA surface here. Changed surfaces are copied into the
//! canvas element's image data at the end of the task, so Blitz paints them like an image.

use std::collections::HashMap;
use std::sync::Arc;

use blitz_dom::{BaseDocument, NodeId};
use tiny_skia::{
    BlendMode, FillRule, FilterQuality, GradientStop, LineCap, LineJoin, LinearGradient, Mask,
    Paint, Path, PathBuilder, Pixmap, PixmapPaint, Point, RadialGradient, Shader, SpreadMode,
    Stroke, StrokeDash, Transform,
};

use crate::cx::{Cx, JsErr, NResult, array_buffer_from_vec, bytes_of};

/// Numbers of a JS array or typed array.
fn read_f64s(scope: &mut v8::PinScope, v: v8::Local<v8::Value>) -> Vec<f64> {
    if let Ok(ta) = v8::Local::<v8::Float64Array>::try_from(v) {
        let n = ta.length();
        let mut out = vec![0f64; n];
        // SAFETY: f64 has no invalid bit patterns; the buffer holds `n` f64 values.
        let bytes = unsafe { std::slice::from_raw_parts_mut(out.as_mut_ptr() as *mut u8, n * 8) };
        ta.copy_contents(bytes);
        return out;
    }
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(v) {
        return (0..arr.length())
            .map(|k| {
                arr.get_index(scope, k)
                    .and_then(|x| x.number_value(scope))
                    .unwrap_or(0.0)
            })
            .collect();
    }
    Vec::new()
}

fn arr_num(scope: &mut v8::PinScope, arr: v8::Local<v8::Array>, k: u32) -> Option<f64> {
    arr.get_index(scope, k).and_then(|x| x.number_value(scope))
}

fn arr_str(scope: &mut v8::PinScope, arr: v8::Local<v8::Array>, k: u32) -> Option<String> {
    arr.get_index(scope, k).map(|x| x.to_rust_string_lossy(scope))
}

/// One canvas' backing store.
pub(crate) struct Surface {
    pixmap: Option<Pixmap>,
    width: u32,
    height: u32,
    mask: Option<Mask>,
    dirty: bool,
}

impl Surface {
    fn new(width: u32, height: u32) -> Self {
        Surface {
            pixmap: Pixmap::new(width, height),
            width,
            height,
            mask: None,
            dirty: true,
        }
    }
}

/// Canvas surfaces of a runtime, by `<canvas>` node.
#[derive(Default)]
pub(crate) struct Canvases {
    surfaces: HashMap<NodeId, Surface>,
    /// Decoded `<img>` pixels as premultiplied pixmaps, by image data identity.
    image_cache: HashMap<usize, Arc<Pixmap>>,
    any_dirty: bool,
}

impl Canvases {
    /// Copy changed surfaces into their canvas elements' image data.
    pub(crate) fn flush(&mut self, doc: &mut BaseDocument) {
        if !std::mem::take(&mut self.any_dirty) {
            return;
        }
        self.surfaces.retain(|&id, _| doc.get_node(id).is_some());
        for (&id, s) in self.surfaces.iter_mut() {
            if !std::mem::take(&mut s.dirty) {
                continue;
            }
            let rgba = match &s.pixmap {
                Some(p) => demultiply(p.data()),
                None => Vec::new(),
            };
            doc.set_canvas_pixels(id, s.width, s.height, rgba);
        }
    }
}

fn demultiply(data: &[u8]) -> Vec<u8> {
    let mut out = data.to_vec();
    for px in out.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a != 0 && a != 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * 255 + a / 2) / a).min(255) as u8;
            }
        }
    }
    out
}

fn premultiply(data: &mut [u8]) {
    for px in data.chunks_exact_mut(4) {
        let a = px[3] as u32;
        if a != 255 {
            for c in &mut px[..3] {
                *c = ((*c as u32 * a + 127) / 255) as u8;
            }
        }
    }
}

fn blend_mode(op: &str) -> BlendMode {
    match op {
        "source-in" => BlendMode::SourceIn,
        "source-out" => BlendMode::SourceOut,
        "source-atop" => BlendMode::SourceAtop,
        "destination-over" => BlendMode::DestinationOver,
        "destination-in" => BlendMode::DestinationIn,
        "destination-out" => BlendMode::DestinationOut,
        "destination-atop" => BlendMode::DestinationAtop,
        "lighter" => BlendMode::Plus,
        "copy" => BlendMode::Source,
        "xor" => BlendMode::Xor,
        "multiply" => BlendMode::Multiply,
        "screen" => BlendMode::Screen,
        "overlay" => BlendMode::Overlay,
        "darken" => BlendMode::Darken,
        "lighten" => BlendMode::Lighten,
        "color-dodge" => BlendMode::ColorDodge,
        "color-burn" => BlendMode::ColorBurn,
        "hard-light" => BlendMode::HardLight,
        "soft-light" => BlendMode::SoftLight,
        "difference" => BlendMode::Difference,
        "exclusion" => BlendMode::Exclusion,
        "hue" => BlendMode::Hue,
        "saturation" => BlendMode::Saturation,
        "color" => BlendMode::Color,
        "luminosity" => BlendMode::Luminosity,
        _ => BlendMode::SourceOver,
    }
}

fn transform_of(m: &[f64]) -> Transform {
    if m.len() < 6 {
        return Transform::identity();
    }
    Transform::from_row(
        m[0] as f32, m[1] as f32, m[2] as f32, m[3] as f32, m[4] as f32, m[5] as f32,
    )
}

/// A path encoded by the JS layer: `0 x y` move, `1 x y` line, `2 cx cy x y` quad,
/// `3 c1x c1y c2x c2y x y` cubic, `4` close.
fn path_of(cmds: &[f64]) -> Option<Path> {
    let mut pb = PathBuilder::new();
    let mut i = 0;
    let f = |i: usize| cmds.get(i).copied().unwrap_or(0.0) as f32;
    while i < cmds.len() {
        match cmds[i] as u32 {
            0 => {
                pb.move_to(f(i + 1), f(i + 2));
                i += 3;
            }
            1 => {
                pb.line_to(f(i + 1), f(i + 2));
                i += 3;
            }
            2 => {
                pb.quad_to(f(i + 1), f(i + 2), f(i + 3), f(i + 4));
                i += 5;
            }
            3 => {
                pb.cubic_to(f(i + 1), f(i + 2), f(i + 3), f(i + 4), f(i + 5), f(i + 6));
                i += 7;
            }
            4 => {
                pb.close();
                i += 1;
            }
            _ => return None,
        }
    }
    pb.finish()
}

/// Gradient stops `(offset, r, g, b, a)*` starting at `from`, with `alpha` applied.
fn stops_of(p: &[f64], from: usize, alpha: f32) -> Vec<(f32, tiny_skia::Color)> {
    p.get(from..)
        .unwrap_or(&[])
        .chunks_exact(5)
        .map(|s| {
            let c = tiny_skia::Color::from_rgba8(
                s[1] as u8,
                s[2] as u8,
                s[3] as u8,
                (s[4].clamp(0.0, 1.0) as f32 * alpha * 255.0).round() as u8,
            );
            (s[0] as f32, c)
        })
        .collect()
}

fn gradient_stops(stops: Vec<(f32, tiny_skia::Color)>) -> Vec<GradientStop> {
    stops.into_iter().map(|(o, c)| GradientStop::new(o, c)).collect()
}

/// A paint encoded by the JS layer: `[0, r, g, b, a]` color, `[1, x0, y0, x1, y1,
/// stops...]` linear gradient, `[2, x0, y0, r0, x1, y1, r1, stops...]` radial gradient.
/// Patterns are passed separately (see `pattern_arg`). `shader_ts` maps the paint's
/// (user) space to the space of the path it fills.
fn shader_of(p: &[f64], alpha: f32, shader_ts: Transform) -> Option<Shader<'static>> {
    let g = |i: usize| p.get(i).copied().unwrap_or(0.0) as f32;
    match p.first().copied().unwrap_or(0.0) as u32 {
        0 => Some(Shader::SolidColor(tiny_skia::Color::from_rgba8(
            g(1) as u8,
            g(2) as u8,
            g(3) as u8,
            (g(4).clamp(0.0, 1.0) * alpha * 255.0).round() as u8,
        ))),
        1 => {
            let stops = stops_of(p, 5, alpha);
            if stops.is_empty() {
                return None;
            }
            let (s, e) = (Point::from_xy(g(1), g(2)), Point::from_xy(g(3), g(4)));
            if s == e {
                // A degenerate gradient paints nothing.
                return None;
            }
            LinearGradient::new(s, e, gradient_stops(stops), SpreadMode::Pad, shader_ts)
        }
        2 => {
            let (r0, r1) = (g(3), g(6));
            let mut stops = stops_of(p, 7, alpha);
            if stops.is_empty() || r1 <= 0.0 {
                return None;
            }
            // tiny-skia's radial gradients start at radius 0: map the stops onto r0..r1.
            if r0 > 0.0 && r0 < r1 {
                let k = r0 / r1;
                let first = stops[0].1;
                for s in &mut stops {
                    s.0 = k + s.0 * (1.0 - k);
                }
                stops.insert(0, (0.0, first));
            }
            RadialGradient::new(
                Point::from_xy(g(1), g(2)),
                Point::from_xy(g(4), g(5)),
                r1,
                gradient_stops(stops),
                SpreadMode::Pad,
                shader_ts,
            )
        }
        _ => None,
    }
}

fn surface<'a>(cx: &Cx, map: &'a mut Canvases, id: NodeId) -> Option<&'a mut Surface> {
    let _ = cx;
    map.surfaces.get_mut(&id)
}

fn node_arg(cx: &mut Cx, i: i32) -> Result<NodeId, JsErr> {
    let doc = cx.st.doc()?;
    cx.node(doc, i)
}

fn floats(cx: &mut Cx, i: i32) -> Vec<f64> {
    let v = cx.arg(i);
    read_f64s(cx.scope, v)
}

/// `N.canvasReset(id, width, height)`: a new, transparent surface (setting the canvas'
/// size or creating its context).
pub(crate) fn n_canvas_reset(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let (w, h) = (cx.num(1).max(0.0) as u32, cx.num(2).max(0.0) as u32);
    let mut map = cx.st.canvases.borrow_mut();
    map.surfaces.insert(id, Surface::new(w.min(16384), h.min(16384)));
    map.any_dirty = true;
    Ok(())
}

fn paint_for(p: &[f64], alpha: f32, op: &str, shader_ts: Transform) -> Option<Paint<'static>> {
    Some(Paint {
        shader: shader_of(p, alpha, shader_ts)?,
        blend_mode: blend_mode(op),
        anti_alias: true,
        force_hq_pipeline: false,
    })
}

/// `N.canvasFill(id, path, evenOdd, paint, alpha, op, ctm)`: fill a device-space path;
/// `ctm` places the paint (gradients are in user space).
pub(crate) fn n_canvas_fill(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let path = floats(cx, 1);
    let even_odd = cx.bool(2);
    let p = floats(cx, 3);
    let alpha = cx.num(4) as f32;
    let op = cx.string(5)?;
    let ctm = transform_of(&floats(cx, 6));
    let pattern = pattern_arg(cx, 7)?;
    let Some(path) = path_of(&path) else { return Ok(()) };
    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    let rule = if even_odd { FillRule::EvenOdd } else { FillRule::Winding };
    let Some(pm) = s.pixmap.as_mut() else { return Ok(()) };
    match &pattern {
        Some((src, repeat, pts)) => {
            let shader = tiny_skia::Pattern::new(
                (**src).as_ref(),
                *repeat,
                FilterQuality::Bilinear,
                alpha,
                ctm.pre_concat(*pts),
            );
            let paint = Paint { shader, blend_mode: blend_mode(&op), anti_alias: true, force_hq_pipeline: false };
            pm.fill_path(&path, &paint, rule, Transform::identity(), s.mask.as_ref());
        }
        None => {
            let Some(paint) = paint_for(&p, alpha, &op, ctm) else { return Ok(()) };
            pm.fill_path(&path, &paint, rule, Transform::identity(), s.mask.as_ref());
        }
    }
    s.dirty = true;
    map.any_dirty = true;
    Ok(())
}

/// `N.canvasStroke(id, path, paint, lineWidth, cap, join, miterLimit, dash, dashOffset,
/// ctm, alpha, op)`: stroke a device-space path with the pen in user space.
pub(crate) fn n_canvas_stroke(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let path = floats(cx, 1);
    let p = floats(cx, 2);
    let width = cx.num(3) as f32;
    let cap = cx.string(4)?;
    let join = cx.string(5)?;
    let miter = cx.num(6) as f32;
    let dash = floats(cx, 7);
    let dash_offset = cx.num(8) as f32;
    let ctm = transform_of(&floats(cx, 9));
    let alpha = cx.num(10) as f32;
    let op = cx.string(11)?;
    let pattern = pattern_arg(cx, 12)?;
    let Some(inv) = ctm.invert() else { return Ok(()) };
    let Some(path) = path_of(&path).and_then(|p| p.transform(inv)) else { return Ok(()) };
    let stroke = Stroke {
        width,
        miter_limit: miter,
        line_cap: match cap.as_str() {
            "round" => LineCap::Round,
            "square" => LineCap::Square,
            _ => LineCap::Butt,
        },
        line_join: match join.as_str() {
            "round" => LineJoin::Round,
            "bevel" => LineJoin::Bevel,
            _ => LineJoin::Miter,
        },
        dash: if dash.is_empty() {
            None
        } else {
            let mut d: Vec<f32> = dash.iter().map(|v| *v as f32).collect();
            if d.len() % 2 == 1 {
                d.extend_from_within(..);
            }
            StrokeDash::new(d, dash_offset)
        },
    };
    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    let Some(pm) = s.pixmap.as_mut() else { return Ok(()) };
    match &pattern {
        Some((src, repeat, pts)) => {
            let shader = tiny_skia::Pattern::new((**src).as_ref(), *repeat, FilterQuality::Bilinear, alpha, *pts);
            let paint = Paint { shader, blend_mode: blend_mode(&op), anti_alias: true, force_hq_pipeline: false };
            pm.stroke_path(&path, &paint, &stroke, ctm, s.mask.as_ref());
        }
        None => {
            let Some(paint) = paint_for(&p, alpha, &op, Transform::identity()) else { return Ok(()) };
            pm.stroke_path(&path, &paint, &stroke, ctm, s.mask.as_ref());
        }
    }
    s.dirty = true;
    map.any_dirty = true;
    Ok(())
}

/// `N.canvasClip(id, [path, evenOdd, path, evenOdd, ...])`: the intersection of the
/// device-space paths becomes the clip (an empty list removes it).
pub(crate) fn n_canvas_clip(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let list = cx.arg(1);
    let mut clips = Vec::new();
    if let Ok(arr) = v8::Local::<v8::Array>::try_from(list) {
        let n = arr.length();
        let mut i = 0;
        while i + 1 < n {
            let pv = arr.get_index(cx.scope, i).ok_or(JsErr::Thrown)?;
            let path = read_f64s(cx.scope, pv);
            let eo = arr
                .get_index(cx.scope, i + 1)
                .is_some_and(|v| v.boolean_value(cx.scope));
            clips.push((path, eo));
            i += 2;
        }
    }
    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    if clips.is_empty() {
        s.mask = None;
        return Ok(());
    }
    let Some(mut mask) = Mask::new(s.width.max(1), s.height.max(1)) else { return Ok(()) };
    let mut first = true;
    for (path, eo) in clips {
        let rule = if eo { FillRule::EvenOdd } else { FillRule::Winding };
        match path_of(&path) {
            Some(path) if first => mask.fill_path(&path, rule, true, Transform::identity()),
            Some(path) => mask.intersect_path(&path, rule, true, Transform::identity()),
            // An empty clip path clips everything.
            None => mask.clear(),
        }
        first = false;
    }
    s.mask = Some(mask);
    Ok(())
}

/// `N.canvasClearRect(id, x, y, w, h, ctm)`.
pub(crate) fn n_canvas_clear_rect(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let (x, y, w, h) = (cx.num(1) as f32, cx.num(2) as f32, cx.num(3) as f32, cx.num(4) as f32);
    let ctm = transform_of(&floats(cx, 5));
    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    let Some(pm) = s.pixmap.as_mut() else { return Ok(()) };
    let (x0, x1) = (x.min(x + w), x.max(x + w));
    let (y0, y1) = (y.min(y + h), y.max(y + h));
    if let Some(rect) = tiny_skia::Rect::from_ltrb(x0, y0, x1, y1) {
        if ctm.is_identity() && s.mask.is_none() && x0 <= 0.0 && y0 <= 0.0
            && x1 >= s.width as f32 && y1 >= s.height as f32
        {
            pm.fill(tiny_skia::Color::TRANSPARENT);
        } else {
            let paint = Paint {
                shader: Shader::SolidColor(tiny_skia::Color::BLACK),
                blend_mode: BlendMode::Clear,
                anti_alias: true,
                force_hq_pipeline: false,
            };
            pm.fill_path(&PathBuilder::from_rect(rect), &paint, FillRule::Winding, ctm, s.mask.as_ref());
        }
        s.dirty = true;
        map.any_dirty = true;
    }
    Ok(())
}

/// Pixels of an image source: `kind` 0 = element (`<img>` or `<canvas>`) node id,
/// 1 = straight RGBA bytes of `w`×`h` (ImageData, ImageBitmap).
fn source_pixmap(cx: &mut Cx, kind: u32, i: i32, w: u32, h: u32) -> Result<Option<Arc<Pixmap>>, JsErr> {
    if kind == 1 {
        let v = cx.arg(i);
        let Some(mut bytes) = bytes_of(cx.scope, v) else { return Ok(None) };
        if w == 0 || h == 0 || bytes.len() != (w * h * 4) as usize {
            return Ok(None);
        }
        premultiply(&mut bytes);
        return Ok(tiny_skia::IntSize::from_wh(w, h)
            .and_then(|size| Pixmap::from_vec(bytes, size))
            .map(Arc::new));
    }
    let id = node_arg(cx, i)?;
    {
        let map = cx.st.canvases.borrow();
        if let Some(s) = map.surfaces.get(&id) {
            return Ok(s.pixmap.clone().map(Arc::new));
        }
    }
    let doc = cx.st.doc()?;
    let Some(raster) = doc
        .get_node(id)
        .and_then(|n| n.element_data())
        .and_then(|el| el.raster_image_data())
    else {
        return Ok(None);
    };
    let key = raster.data.id() as usize;
    let mut map = cx.st.canvases.borrow_mut();
    if let Some(p) = map.image_cache.get(&key) {
        return Ok(Some(p.clone()));
    }
    let mut bytes = raster.data.data().to_vec();
    if bytes.len() != (raster.width * raster.height * 4) as usize {
        return Ok(None);
    }
    premultiply(&mut bytes);
    let pm = tiny_skia::IntSize::from_wh(raster.width, raster.height)
        .and_then(|size| Pixmap::from_vec(bytes, size))
        .map(Arc::new);
    if let Some(p) = &pm {
        if map.image_cache.len() > 64 {
            map.image_cache.clear();
        }
        map.image_cache.insert(key, p.clone());
    }
    Ok(pm)
}

/// A pattern argument: `null` or `[kind, source, w, h, repetition, m0..m5]` with the
/// source at index 1 of that array.
fn pattern_arg(cx: &mut Cx, i: i32) -> Result<Option<(Arc<Pixmap>, SpreadMode, Transform)>, JsErr> {
    let v = cx.arg(i);
    let Ok(arr) = v8::Local::<v8::Array>::try_from(v) else { return Ok(None) };
    let kind = arr_num(cx.scope, arr, 0).unwrap_or(0.0) as u32;
    let w = arr_num(cx.scope, arr, 2).unwrap_or(0.0) as u32;
    let h = arr_num(cx.scope, arr, 3).unwrap_or(0.0) as u32;
    let repeat = arr_str(cx.scope, arr, 4).unwrap_or_default();
    let mut m = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];
    for (k, slot) in m.iter_mut().enumerate() {
        if let Some(n) = arr_num(cx.scope, arr, 5 + k as u32) {
            *slot = n;
        }
    }
    // Put the source where `source_pixmap` expects it.
    let src = arr.get_index(cx.scope, 1).ok_or(JsErr::Thrown)?;
    let pm = {
        // `source_pixmap` reads argument slots; emulate with a temporary lookup.
        if kind == 1 {
            let Some(mut bytes) = bytes_of(cx.scope, src) else { return Ok(None) };
            if w == 0 || h == 0 || bytes.len() != (w * h * 4) as usize {
                return Ok(None);
            }
            premultiply(&mut bytes);
            tiny_skia::IntSize::from_wh(w, h)
                .and_then(|size| Pixmap::from_vec(bytes, size))
                .map(Arc::new)
        } else {
            let n = src.number_value(cx.scope).unwrap_or(0.0);
            let Some(id) = crate::cx::node_id_from_js(n) else { return Ok(None) };
            element_pixmap(cx, id)?
        }
    };
    let Some(pm) = pm else { return Ok(None) };
    // tiny-skia repeats in both directions or none; "repeat-x"/"repeat-y" repeat both.
    let spread = if repeat == "no-repeat" { SpreadMode::Pad } else { SpreadMode::Repeat };
    Ok(Some((pm, spread, transform_of(&m))))
}

fn element_pixmap(cx: &mut Cx, id: NodeId) -> Result<Option<Arc<Pixmap>>, JsErr> {
    {
        let map = cx.st.canvases.borrow();
        if let Some(s) = map.surfaces.get(&id) {
            return Ok(s.pixmap.clone().map(Arc::new));
        }
    }
    let doc = cx.st.doc()?;
    let Some(raster) = doc
        .get_node(id)
        .and_then(|n| n.element_data())
        .and_then(|el| el.raster_image_data())
    else {
        return Ok(None);
    };
    let mut bytes = raster.data.data().to_vec();
    if bytes.len() != (raster.width * raster.height * 4) as usize {
        return Ok(None);
    }
    premultiply(&mut bytes);
    Ok(tiny_skia::IntSize::from_wh(raster.width, raster.height)
        .and_then(|size| Pixmap::from_vec(bytes, size))
        .map(Arc::new))
}

/// `N.canvasDrawImage(id, kind, source, srcW, srcH, sx, sy, sw, sh, dx, dy, dw, dh, ctm,
/// alpha, op, smoothing)`.
pub(crate) fn n_canvas_draw_image(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let kind = cx.num(1) as u32;
    let (src_w, src_h) = (cx.num(3).max(0.0) as u32, cx.num(4).max(0.0) as u32);
    let Some(src) = source_pixmap(cx, kind, 2, src_w, src_h)? else { return Ok(()) };
    let r: Vec<f32> = (5..13).map(|i| cx.num(i) as f32).collect();
    let (sx, sy, sw, sh, dx, dy, dw, dh) = (r[0], r[1], r[2], r[3], r[4], r[5], r[6], r[7]);
    let ctm = transform_of(&floats(cx, 13));
    let alpha = cx.num(14) as f32;
    let op = cx.string(15)?;
    let smooth = cx.bool(16);
    if sw == 0.0 || sh == 0.0 || dw == 0.0 || dh == 0.0 {
        return Ok(());
    }
    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    let Some(pm) = s.pixmap.as_mut() else { return Ok(()) };
    // Draw the source rectangle as a pattern-filled destination rectangle.
    let (kx, ky) = (dw / sw, dh / sh);
    let pattern_ts = ctm.pre_concat(Transform::from_row(kx, 0.0, 0.0, ky, dx - sx * kx, dy - sy * ky));
    let shader = tiny_skia::Pattern::new(
        (*src).as_ref(),
        SpreadMode::Pad,
        if smooth { FilterQuality::Bilinear } else { FilterQuality::Nearest },
        alpha,
        pattern_ts,
    );
    let paint = Paint { shader, blend_mode: blend_mode(&op), anti_alias: true, force_hq_pipeline: false };
    let (x0, x1) = (dx.min(dx + dw), dx.max(dx + dw));
    let (y0, y1) = (dy.min(dy + dh), dy.max(dy + dh));
    if let Some(rect) = tiny_skia::Rect::from_ltrb(x0, y0, x1, y1) {
        pm.fill_path(&PathBuilder::from_rect(rect), &paint, FillRule::Winding, ctm, s.mask.as_ref());
        s.dirty = true;
        map.any_dirty = true;
    }
    let _ = PixmapPaint::default();
    Ok(())
}

/// `N.canvasGetImageData(id, x, y, w, h)` -> ArrayBuffer of straight RGBA.
pub(crate) fn n_canvas_get_image_data(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let (x, y) = (cx.num(1) as i64, cx.num(2) as i64);
    let (w, h) = (cx.num(3).max(0.0) as u32, cx.num(4).max(0.0) as u32);
    if (w as u64) * (h as u64) > 256 * 1024 * 1024 {
        return Err(JsErr::range("the ImageData is too large"));
    }
    let mut out = vec![0u8; (w * h * 4) as usize];
    let map = cx.st.canvases.borrow();
    if let Some(pm) = map.surfaces.get(&id).and_then(|s| s.pixmap.as_ref()) {
        let (pw, ph) = (pm.width() as i64, pm.height() as i64);
        let data = pm.data();
        for row in 0..h as i64 {
            let sy = y + row;
            if sy < 0 || sy >= ph {
                continue;
            }
            let x0 = x.max(0);
            let x1 = (x + w as i64).min(pw);
            if x0 >= x1 {
                continue;
            }
            let src = &data[((sy * pw + x0) * 4) as usize..((sy * pw + x1) * 4) as usize];
            let dst_start = ((row * w as i64 + (x0 - x)) * 4) as usize;
            out[dst_start..dst_start + src.len()].copy_from_slice(&demultiply(src));
        }
    }
    drop(map);
    let ab = array_buffer_from_vec(cx.scope, out);
    cx.ret_value(ab.into());
    Ok(())
}

/// `N.canvasPutImageData(id, bytes, w, h, dx, dy, dirtyX, dirtyY, dirtyW, dirtyH)`:
/// copy pixels (no compositing, transform or clip).
pub(crate) fn n_canvas_put_image_data(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let v = cx.arg(1);
    let bytes = bytes_of(cx.scope, v).unwrap_or_default();
    let (w, h) = (cx.num(2).max(0.0) as i64, cx.num(3).max(0.0) as i64);
    let (dx, dy) = (cx.num(4) as i64, cx.num(5) as i64);
    let (rx, ry, rw, rh) = (cx.num(6) as i64, cx.num(7) as i64, cx.num(8) as i64, cx.num(9) as i64);
    if bytes.len() as i64 != w * h * 4 {
        return Ok(());
    }
    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    let Some(pm) = s.pixmap.as_mut() else { return Ok(()) };
    let (pw, ph) = (pm.width() as i64, pm.height() as i64);
    let data = pm.data_mut();
    let (x0, x1) = (rx.max(0), (rx + rw).min(w));
    let (y0, y1) = (ry.max(0), (ry + rh).min(h));
    for sy in y0..y1 {
        let ty = dy + sy;
        if ty < 0 || ty >= ph {
            continue;
        }
        for sx in x0..x1 {
            let tx = dx + sx;
            if tx < 0 || tx >= pw {
                continue;
            }
            let si = ((sy * w + sx) * 4) as usize;
            let ti = ((ty * pw + tx) * 4) as usize;
            let mut px = [bytes[si], bytes[si + 1], bytes[si + 2], bytes[si + 3]];
            premultiply(&mut px);
            data[ti..ti + 4].copy_from_slice(&px);
        }
    }
    s.dirty = true;
    map.any_dirty = true;
    Ok(())
}

/// `N.canvasToDataURL(id, width, height)` -> a PNG `data:` URL of the canvas (a blank one
/// of `width`×`height` without a surface).
pub(crate) fn n_canvas_to_data_url(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let (w, h) = (cx.num(1).max(0.0) as u32, cx.num(2).max(0.0) as u32);
    let png = {
        let map = cx.st.canvases.borrow();
        match map.surfaces.get(&id).and_then(|s| s.pixmap.as_ref()) {
            Some(pm) => pm.encode_png().ok(),
            None => Pixmap::new(w, h).and_then(|pm| pm.encode_png().ok()),
        }
    };
    match png {
        Some(bytes) => cx.ret_str(&format!("data:image/png;base64,{}", base64(&bytes))),
        None => cx.ret_str("data:,"),
    }
    Ok(())
}

fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

// ---------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------

struct CanvasFont {
    family: String,
    size: f32,
    weight: f32,
    italic: bool,
}

fn font_arg(cx: &mut Cx, i: i32) -> Result<CanvasFont, JsErr> {
    let v = cx.arg(i);
    let arr: v8::Local<v8::Array> = v.try_into().map_err(|_| JsErr::type_err("font"))?;
    let family = arr_str(cx.scope, arr, 0).unwrap_or_default();
    let size = arr_num(cx.scope, arr, 1).unwrap_or(10.0) as f32;
    let weight = arr_num(cx.scope, arr, 2).unwrap_or(400.0) as f32;
    let italic = arr.get_index(cx.scope, 3).is_some_and(|v| v.boolean_value(cx.scope));
    Ok(CanvasFont { family, size, weight, italic })
}

struct TextOutline {
    path: Option<Path>,
    width: f32,
    ascent: f32,
    descent: f32,
    ink: Option<tiny_skia::Rect>,
}

struct PathPen<'a> {
    pb: &'a mut PathBuilder,
    x: f32,
    y: f32,
}

impl skrifa::outline::OutlinePen for PathPen<'_> {
    fn move_to(&mut self, x: f32, y: f32) {
        self.pb.move_to(self.x + x, self.y - y);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.pb.line_to(self.x + x, self.y - y);
    }
    fn quad_to(&mut self, cx0: f32, cy0: f32, x: f32, y: f32) {
        self.pb.quad_to(self.x + cx0, self.y - cy0, self.x + x, self.y - y);
    }
    fn curve_to(&mut self, cx0: f32, cy0: f32, cx1: f32, cy1: f32, x: f32, y: f32) {
        self.pb
            .cubic_to(self.x + cx0, self.y - cy0, self.x + cx1, self.y - cy1, self.x + x, self.y - y);
    }
    fn close(&mut self) {
        self.pb.close();
    }
}

/// Lay out `text` in `font` (one line) and outline its glyphs with the baseline at y = 0.
fn outline_text(doc: &BaseDocument, text: &str, font: &CanvasFont) -> TextOutline {
    use parley::{FontFamily, FontStyle, FontWeight, PositionedLayoutItem, StyleProperty};
    use skrifa::MetadataProvider;

    let font_ctx = doc.font_context();
    let mut font_ctx = font_ctx.lock().unwrap_or_else(|p| p.into_inner());
    thread_local! {
        static LAYOUT_CX: std::cell::RefCell<parley::LayoutContext<()>> =
            std::cell::RefCell::new(parley::LayoutContext::new());
    }
    let layout = LAYOUT_CX.with(|lcx| {
        let mut lcx = lcx.borrow_mut();
        let mut builder = lcx.ranged_builder(&mut font_ctx, text, 1.0, true);
        builder.push_default(StyleProperty::FontFamily(FontFamily::Source(font.family.clone().into())));
        builder.push_default(StyleProperty::FontSize(font.size));
        builder.push_default(StyleProperty::FontWeight(FontWeight::new(font.weight)));
        if font.italic {
            builder.push_default(StyleProperty::FontStyle(FontStyle::Italic));
        }
        let mut layout = builder.build(text);
        layout.break_all_lines(None);
        layout
    });

    let mut pb = PathBuilder::new();
    let mut width = 0.0f32;
    let (mut ascent, mut descent) = (font.size * 0.8, font.size * 0.2);
    if let Some(line) = layout.lines().next() {
        let m = line.metrics();
        width = m.advance;
        // Whole pixels, like Chromium's font metrics (the em box derives from them).
        ascent = m.ascent.round();
        descent = m.descent.round();
        let baseline = m.baseline;
        for item in line.items() {
            let PositionedLayoutItem::GlyphRun(glyph_run) = item else { continue };
            let run = glyph_run.run();
            let font_data = run.font();
            let Ok(font_ref) = skrifa::FontRef::from_index(font_data.data.as_ref(), font_data.index)
            else {
                continue;
            };
            let outlines = font_ref.outline_glyphs();
            let coords: Vec<skrifa::instance::NormalizedCoord> = run
                .normalized_coords()
                .iter()
                .map(|c| skrifa::instance::NormalizedCoord::from_bits(*c))
                .collect();
            let location = skrifa::instance::LocationRef::new(&coords);
            let size = skrifa::instance::Size::new(run.font_size());
            for glyph in glyph_run.positioned_glyphs() {
                let Some(outline) = outlines.get(skrifa::GlyphId::new(glyph.id as u32)) else {
                    continue;
                };
                let mut pen = PathPen { pb: &mut pb, x: glyph.x, y: glyph.y - baseline };
                let settings = skrifa::outline::DrawSettings::unhinted(size, location);
                let _ = outline.draw(settings, &mut pen);
            }
        }
    }
    let path = pb.finish();
    let ink = path.as_ref().map(|p| p.bounds());
    TextOutline { path, width, ascent, descent, ink }
}

/// `N.canvasMeasureText(font, text)` -> `[width, inkLeft, inkRight, inkAscent, inkDescent,
/// fontAscent, fontDescent, emAscent, emDescent]`.
pub(crate) fn n_canvas_measure_text(cx: &mut Cx) -> NResult {
    let font = font_arg(cx, 0)?;
    let text = cx.string(1)?;
    let doc = cx.st.doc()?;
    let t = outline_text(doc, &text, &font);
    let (l, r, a, d) = match t.ink {
        Some(b) => (-b.left(), b.right(), -b.top(), b.bottom()),
        None => (0.0, 0.0, 0.0, 0.0),
    };
    let em = t.ascent + t.descent;
    let (em_a, em_d) = if em > 0.0 {
        (font.size * t.ascent / em, font.size * t.descent / em)
    } else {
        (font.size * 0.8, font.size * 0.2)
    };
    cx.ret_f64s(&[
        t.width as f64,
        l as f64,
        r as f64,
        a as f64,
        d as f64,
        t.ascent as f64,
        t.descent as f64,
        em_a as f64,
        em_d as f64,
    ]);
    Ok(())
}

/// `N.canvasText(id, text, font, x, y, align, baseline, maxWidth, fill, paint, stroke,
/// ctm, alpha, op, pattern)`: `stroke` is `[lineWidth, cap, join, miterLimit]`.
pub(crate) fn n_canvas_text(cx: &mut Cx) -> NResult {
    let id = node_arg(cx, 0)?;
    let text = cx.string(1)?;
    let font = font_arg(cx, 2)?;
    let (x, y) = (cx.num(3) as f32, cx.num(4) as f32);
    let align = cx.string(5)?;
    let baseline = cx.string(6)?;
    let max_width = cx.num(7) as f32;
    let fill = cx.bool(8);
    let p = floats(cx, 9);
    let stroke_v = cx.arg(10);
    let stroke_params: Vec<String> = match v8::Local::<v8::Array>::try_from(stroke_v) {
        Ok(arr) => (0..arr.length())
            .filter_map(|k| arr.get_index(cx.scope, k))
            .map(|v| v.to_rust_string_lossy(cx.scope))
            .collect(),
        Err(_) => Vec::new(),
    };
    let ctm = transform_of(&floats(cx, 11));
    let alpha = cx.num(12) as f32;
    let op = cx.string(13)?;
    let pattern = pattern_arg(cx, 14)?;

    let doc = cx.st.doc()?;
    let t = outline_text(doc, &text, &font);
    let Some(path) = t.path else { return Ok(()) };
    let sx = if max_width.is_finite() && max_width > 0.0 && t.width > max_width {
        max_width / t.width
    } else {
        1.0
    };
    let w = t.width * sx;
    let ax = match align.as_str() {
        "right" | "end" => x - w,
        "center" => x - w / 2.0,
        _ => x,
    };
    // The em box (as in Chromium): the font's ascent and descent scaled to the font size.
    let em = t.ascent + t.descent;
    let (em_a, em_d) = if em > 0.0 {
        (font.size * t.ascent / em, font.size * t.descent / em)
    } else {
        (font.size * 0.8, font.size * 0.2)
    };
    let ay = match baseline.as_str() {
        "top" => y + em_a,
        "hanging" => y + em_a * 0.8,
        "middle" => y + (em_a - em_d) / 2.0,
        "bottom" | "ideographic" => y - em_d,
        _ => y,
    };
    let ts = ctm.pre_concat(Transform::from_row(sx, 0.0, 0.0, 1.0, ax, ay));

    let mut map = cx.st.canvases.borrow_mut();
    let Some(s) = surface(cx, &mut map, id) else { return Ok(()) };
    let Some(pm) = s.pixmap.as_mut() else { return Ok(()) };
    let paint = match &pattern {
        Some((src, repeat, pts)) => Some(Paint {
            shader: tiny_skia::Pattern::new(
                // Patterns are in canvas user space: undo the text placement.
                (**src).as_ref(),
                *repeat,
                FilterQuality::Bilinear,
                alpha,
                Transform::from_row(sx, 0.0, 0.0, 1.0, ax, ay)
                    .invert()
                    .unwrap_or_default()
                    .pre_concat(*pts),
            ),
            blend_mode: blend_mode(&op),
            anti_alias: true,
            force_hq_pipeline: false,
        }),
        None => paint_for(
            &p,
            alpha,
            &op,
            Transform::from_row(sx, 0.0, 0.0, 1.0, ax, ay).invert().unwrap_or_default(),
        ),
    };
    let Some(paint) = paint else { return Ok(()) };
    if fill {
        pm.fill_path(&path, &paint, FillRule::Winding, ts, s.mask.as_ref());
    } else {
        let num = |i: usize, d: f32| stroke_params.get(i).and_then(|v| v.parse().ok()).unwrap_or(d);
        let stroke = Stroke {
            width: num(0, 1.0),
            miter_limit: num(3, 10.0),
            line_cap: match stroke_params.get(1).map(String::as_str) {
                Some("round") => LineCap::Round,
                Some("square") => LineCap::Square,
                _ => LineCap::Butt,
            },
            line_join: match stroke_params.get(2).map(String::as_str) {
                Some("round") => LineJoin::Round,
                Some("bevel") => LineJoin::Bevel,
                _ => LineJoin::Miter,
            },
            dash: None,
        };
        pm.stroke_path(&path, &paint, &stroke, ts, s.mask.as_ref());
    }
    s.dirty = true;
    map.any_dirty = true;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn premultiply_roundtrip() {
        let mut px = vec![200, 100, 50, 128, 10, 20, 30, 255, 1, 2, 3, 0];
        let orig = px.clone();
        premultiply(&mut px);
        let back = demultiply(&px);
        for (a, b) in orig.chunks(4).zip(back.chunks(4)) {
            if a[3] == 0 {
                continue;
            }
            for k in 0..4 {
                assert!((a[k] as i32 - b[k] as i32).abs() <= 2, "{a:?} vs {b:?}");
            }
        }
    }

    #[test]
    fn base64_encoding() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }
}
