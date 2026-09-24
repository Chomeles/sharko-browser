//! Serializable display lists.
//!
//! The renderer process paints the page into a [`DisplayList`] (via
//! [`DisplayListRecorder`], which implements `anyrender::PaintScene`, so the Blitz
//! painter can draw into it directly). The list is shipped over IPC to the browser
//! process, whose compositor replays it into a real rasterizer (Vello on the GPU,
//! or vello_cpu as a fallback / for headless screenshots).
//!
//! Heavy resources (font files, decoded images) are sent only once per renderer
//! connection: the recorder remembers which blob ids the receiver already has, and the
//! receiver keeps them in a [`ResourceCache`].

use anyrender::{Filter, Glyph, NormalizedCoord, Paint, PaintRef, PaintScene, RenderContext};
use kurbo::{Affine, BezPath, PathEl, Point, Rect, RoundedRect, RoundedRectRadii, Shape, Stroke};
use peniko::{
    BlendMode, Blob, Color, Fill, FontData, Gradient, ImageAlphaType, ImageBrush, ImageData,
    ImageFormat, ImageSampler, Style, StyleRef,
};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Affine transform coefficients (`kurbo::Affine::as_coeffs`).
pub type Tf = [f64; 6];

#[inline]
fn tf(a: Affine) -> Tf {
    a.as_coeffs()
}
#[inline]
fn affine(t: &Tf) -> Affine {
    Affine::new(*t)
}

/// A shape. Rects and rounded rects (the vast majority of web content) are kept in
/// their compact form so rasterizers can use fast paths.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum PathData {
    Rect([f64; 4]),
    RoundedRect([f64; 4], [f64; 4]),
    /// verbs: 0 = move, 1 = line, 2 = quad, 3 = cubic, 4 = close
    Path { verbs: Vec<u8>, pts: Vec<f32> },
}

impl PathData {
    pub fn from_shape(shape: &impl Shape) -> Self {
        if let Some(r) = shape.as_rect() {
            return PathData::Rect([r.x0, r.y0, r.x1, r.y1]);
        }
        if let Some(rr) = shape.as_rounded_rect() {
            let r = rr.rect();
            let rad = rr.radii();
            return PathData::RoundedRect(
                [r.x0, r.y0, r.x1, r.y1],
                [rad.top_left, rad.top_right, rad.bottom_right, rad.bottom_left],
            );
        }
        let mut verbs = Vec::new();
        let mut pts = Vec::new();
        for el in shape.path_elements(0.1) {
            match el {
                PathEl::MoveTo(p) => {
                    verbs.push(0);
                    pts.extend([p.x as f32, p.y as f32]);
                }
                PathEl::LineTo(p) => {
                    verbs.push(1);
                    pts.extend([p.x as f32, p.y as f32]);
                }
                PathEl::QuadTo(a, b) => {
                    verbs.push(2);
                    pts.extend([a.x as f32, a.y as f32, b.x as f32, b.y as f32]);
                }
                PathEl::CurveTo(a, b, c) => {
                    verbs.push(3);
                    pts.extend([
                        a.x as f32, a.y as f32, b.x as f32, b.y as f32, c.x as f32, c.y as f32,
                    ]);
                }
                PathEl::ClosePath => verbs.push(4),
            }
        }
        PathData::Path { verbs, pts }
    }

    pub fn to_bez_path(&self) -> BezPath {
        match self {
            PathData::Rect(r) => Rect::new(r[0], r[1], r[2], r[3]).into_path(0.1),
            PathData::RoundedRect(r, rad) => self::rounded(r, rad).into_path(0.1),
            PathData::Path { verbs, pts } => {
                let mut p = BezPath::new();
                let mut i = 0usize;
                let pt = |i: usize| Point::new(pts[i] as f64, pts[i + 1] as f64);
                for v in verbs {
                    match v {
                        0 => {
                            p.move_to(pt(i));
                            i += 2;
                        }
                        1 => {
                            p.line_to(pt(i));
                            i += 2;
                        }
                        2 => {
                            p.quad_to(pt(i), pt(i + 2));
                            i += 4;
                        }
                        3 => {
                            p.curve_to(pt(i), pt(i + 2), pt(i + 4));
                            i += 6;
                        }
                        _ => p.close_path(),
                    }
                }
                p
            }
        }
    }

    /// Axis-aligned bounds (before transform).
    pub fn bounds(&self) -> Rect {
        match self {
            PathData::Rect(r) | PathData::RoundedRect(r, _) => Rect::new(r[0], r[1], r[2], r[3]),
            PathData::Path { .. } => self.to_bez_path().bounding_box(),
        }
    }
}

fn rounded(r: &[f64; 4], rad: &[f64; 4]) -> RoundedRect {
    RoundedRect::from_rect(
        Rect::new(r[0], r[1], r[2], r[3]),
        RoundedRectRadii::new(rad[0], rad[1], rad[2], rad[3]),
    )
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum BrushData {
    Solid(Color),
    Gradient(Gradient),
    Image { id: u64, sampler: ImageSampler },
    /// Unsupported paint (custom widget resource) — draws nothing.
    None,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum StyleData {
    Fill(Fill),
    Stroke(Stroke),
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct GlyphRun {
    pub font_id: u64,
    pub font_index: u32,
    pub font_size: f32,
    pub hint: bool,
    pub coords: Vec<NormalizedCoord>,
    pub embolden: [f64; 2],
    pub style: StyleData,
    pub brush: BrushData,
    pub brush_alpha: f32,
    pub transform: Tf,
    pub glyph_transform: Option<Tf>,
    pub glyphs: Vec<Glyph>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Cmd {
    PushLayer {
        blend: BlendMode,
        alpha: f32,
        transform: Tf,
        clip: PathData,
        filter: Option<Filter>,
        backdrop_filter: Option<Filter>,
    },
    PushClip {
        transform: Tf,
        clip: PathData,
    },
    Pop,
    Fill {
        fill: Fill,
        transform: Tf,
        brush: BrushData,
        brush_transform: Option<Tf>,
        shape: PathData,
    },
    Stroke {
        style: Stroke,
        transform: Tf,
        brush: BrushData,
        brush_transform: Option<Tf>,
        shape: PathData,
    },
    Glyphs(Box<GlyphRun>),
    BoxShadow {
        transform: Tf,
        rect: [f64; 4],
        color: Color,
        radius: f64,
        std_dev: f64,
    },
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FontResource {
    pub id: u64,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ImageResource {
    pub id: u64,
    pub width: u32,
    pub height: u32,
    /// 0 = Rgba8, 1 = Bgra8
    pub format: u8,
    /// 0 = Alpha (straight), 1 = AlphaPremultiplied
    pub alpha_type: u8,
    #[serde(with = "serde_bytes")]
    pub data: Vec<u8>,
}

/// A recorded frame: drawing commands plus any resources the receiver doesn't have yet.
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct DisplayList {
    pub cmds: Vec<Cmd>,
    pub new_fonts: Vec<FontResource>,
    pub new_images: Vec<ImageResource>,
}

impl DisplayList {
    pub fn is_empty(&self) -> bool {
        self.cmds.is_empty()
    }
}

/// Sender-side memory of which resources the receiver already has.
#[derive(Default)]
pub struct SentResources {
    fonts: HashSet<u64>,
    images: HashSet<u64>,
}

impl SentResources {
    pub fn clear(&mut self) {
        self.fonts.clear();
        self.images.clear();
    }
}

/// `PaintScene` implementation that records into a [`DisplayList`].
pub struct DisplayListRecorder<'a> {
    pub list: DisplayList,
    sent: &'a mut SentResources,
}

impl<'a> DisplayListRecorder<'a> {
    pub fn new(sent: &'a mut SentResources) -> Self {
        Self {
            list: DisplayList::default(),
            sent,
        }
    }

    pub fn finish(self) -> DisplayList {
        self.list
    }

    fn brush(&mut self, paint: PaintRef<'_>) -> BrushData {
        match paint {
            Paint::Solid(c) => BrushData::Solid(c),
            Paint::Gradient(g) => BrushData::Gradient(g.clone()),
            Paint::Image(img) => {
                let data = img.image;
                let id = data.data.id();
                if self.sent.images.insert(id) {
                    self.list.new_images.push(ImageResource {
                        id,
                        width: data.width,
                        height: data.height,
                        format: match data.format {
                            ImageFormat::Bgra8 => 1,
                            _ => 0,
                        },
                        alpha_type: match data.alpha_type {
                            ImageAlphaType::AlphaPremultiplied => 1,
                            _ => 0,
                        },
                        data: data.data.data().to_vec(),
                    });
                }
                BrushData::Image {
                    id,
                    sampler: img.sampler,
                }
            }
            Paint::Resource(_) | Paint::Custom(_) => BrushData::None,
        }
    }

    fn font(&mut self, font: &FontData) -> u64 {
        let id = font.data.id();
        if self.sent.fonts.insert(id) {
            self.list.new_fonts.push(FontResource {
                id,
                data: font.data.data().to_vec(),
            });
        }
        id
    }
}

impl RenderContext for DisplayListRecorder<'_> {}

impl PaintScene for DisplayListRecorder<'_> {
    fn reset(&mut self) {
        self.list.cmds.clear();
    }

    fn push_layer(
        &mut self,
        blend: impl Into<BlendMode>,
        alpha: f32,
        transform: Affine,
        clip: &impl Shape,
        filter: Option<Arc<Filter>>,
        backdrop_filter: Option<Arc<Filter>>,
    ) {
        self.list.cmds.push(Cmd::PushLayer {
            blend: blend.into(),
            alpha,
            transform: tf(transform),
            clip: PathData::from_shape(clip),
            filter: filter.map(|f| (*f).clone()),
            backdrop_filter: backdrop_filter.map(|f| (*f).clone()),
        });
    }

    fn push_clip_layer(&mut self, transform: Affine, clip: &impl Shape) {
        self.list.cmds.push(Cmd::PushClip {
            transform: tf(transform),
            clip: PathData::from_shape(clip),
        });
    }

    fn pop_layer(&mut self) {
        self.list.cmds.push(Cmd::Pop);
    }

    fn stroke<'b>(
        &mut self,
        style: &Stroke,
        transform: Affine,
        brush: impl Into<PaintRef<'b>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let brush = self.brush(brush.into());
        self.list.cmds.push(Cmd::Stroke {
            style: style.clone(),
            transform: tf(transform),
            brush,
            brush_transform: brush_transform.map(tf),
            shape: PathData::from_shape(shape),
        });
    }

    fn fill<'b>(
        &mut self,
        style: Fill,
        transform: Affine,
        brush: impl Into<PaintRef<'b>>,
        brush_transform: Option<Affine>,
        shape: &impl Shape,
    ) {
        let brush = self.brush(brush.into());
        self.list.cmds.push(Cmd::Fill {
            fill: style,
            transform: tf(transform),
            brush,
            brush_transform: brush_transform.map(tf),
            shape: PathData::from_shape(shape),
        });
    }

    fn draw_glyphs<'b, 's: 'b>(
        &'s mut self,
        font: &'b FontData,
        font_size: f32,
        hint: bool,
        normalized_coords: &'b [NormalizedCoord],
        embolden: kurbo::Vec2,
        style: impl Into<StyleRef<'b>>,
        brush: impl Into<PaintRef<'b>>,
        brush_alpha: f32,
        transform: Affine,
        glyph_transform: Option<Affine>,
        glyphs: impl Iterator<Item = Glyph> + Clone,
    ) {
        let font_id = self.font(font);
        let brush = self.brush(brush.into());
        let style = match style.into() {
            StyleRef::Fill(f) => StyleData::Fill(f),
            StyleRef::Stroke(s) => StyleData::Stroke(s.clone()),
        };
        self.list.cmds.push(Cmd::Glyphs(Box::new(GlyphRun {
            font_id,
            font_index: font.index,
            font_size,
            hint,
            coords: normalized_coords.to_vec(),
            embolden: [embolden.x, embolden.y],
            style,
            brush,
            brush_alpha,
            transform: tf(transform),
            glyph_transform: glyph_transform.map(tf),
            glyphs: glyphs.collect(),
        })));
    }

    fn draw_box_shadow(
        &mut self,
        transform: Affine,
        rect: Rect,
        brush: Color,
        radius: f64,
        std_dev: f64,
    ) {
        self.list.cmds.push(Cmd::BoxShadow {
            transform: tf(transform),
            rect: [rect.x0, rect.y0, rect.x1, rect.y1],
            color: brush,
            radius,
            std_dev,
        });
    }
}

/// Receiver-side store of fonts and images, keyed by the sender's blob ids.
/// Blobs are created once so rasterizer caches (glyph atlases, image uploads) stay warm.
#[derive(Default)]
pub struct ResourceCache {
    fonts: HashMap<u64, Blob<u8>>,
    images: HashMap<u64, ImageData>,
}

impl ResourceCache {
    /// Move the resources out of `list` into the cache.
    pub fn ingest(&mut self, list: &mut DisplayList) {
        for f in list.new_fonts.drain(..) {
            self.fonts.insert(f.id, Blob::new(Arc::new(f.data)));
        }
        for i in list.new_images.drain(..) {
            self.images.insert(
                i.id,
                ImageData {
                    data: Blob::new(Arc::new(i.data)),
                    format: if i.format == 1 {
                        ImageFormat::Bgra8
                    } else {
                        ImageFormat::Rgba8
                    },
                    alpha_type: if i.alpha_type == 1 {
                        ImageAlphaType::AlphaPremultiplied
                    } else {
                        ImageAlphaType::Alpha
                    },
                    width: i.width,
                    height: i.height,
                },
            );
        }
    }

    pub fn clear(&mut self) {
        self.fonts.clear();
        self.images.clear();
    }

    pub fn font_count(&self) -> usize {
        self.fonts.len()
    }
    pub fn image_count(&self) -> usize {
        self.images.len()
    }
}

macro_rules! with_shape {
    ($shape:expr, |$s:ident| $body:expr) => {
        match $shape {
            PathData::Rect(r) => {
                let $s = Rect::new(r[0], r[1], r[2], r[3]);
                $body
            }
            PathData::RoundedRect(r, rad) => {
                let $s = rounded(r, rad);
                $body
            }
            p @ PathData::Path { .. } => {
                let $s = p.to_bez_path();
                $body
            }
        }
    };
}

macro_rules! with_brush {
    ($brush:expr, $cache:expr, |$b:ident| $body:expr) => {
        match $brush {
            BrushData::Solid(c) => {
                let $b: PaintRef<'_> = Paint::Solid(*c);
                $body
            }
            BrushData::Gradient(g) => {
                let $b: PaintRef<'_> = Paint::Gradient(g);
                $body
            }
            BrushData::Image { id, sampler } => {
                if let Some(img) = $cache.images.get(id) {
                    let $b: PaintRef<'_> = Paint::Image(ImageBrush {
                        image: img,
                        sampler: *sampler,
                    });
                    $body
                }
            }
            BrushData::None => {}
        }
    };
}

/// Replay a display list into any `PaintScene` (Vello GPU, vello_cpu, ...), applying
/// `base` as an extra transform (e.g. to offset content below the browser toolbar).
pub fn replay(list: &DisplayList, cache: &ResourceCache, scene: &mut impl PaintScene, base: Affine) {
    for cmd in &list.cmds {
        match cmd {
            Cmd::PushLayer {
                blend,
                alpha,
                transform,
                clip,
                filter,
                backdrop_filter,
            } => {
                let t = base * affine(transform);
                let f = filter.clone().map(Arc::new);
                let bf = backdrop_filter.clone().map(Arc::new);
                with_shape!(clip, |s| scene.push_layer(*blend, *alpha, t, &s, f, bf));
            }
            Cmd::PushClip { transform, clip } => {
                let t = base * affine(transform);
                with_shape!(clip, |s| scene.push_clip_layer(t, &s));
            }
            Cmd::Pop => scene.pop_layer(),
            Cmd::Fill {
                fill,
                transform,
                brush,
                brush_transform,
                shape,
            } => {
                let t = base * affine(transform);
                let bt = brush_transform.as_ref().map(affine);
                with_brush!(brush, cache, |b| {
                    with_shape!(shape, |s| scene.fill(*fill, t, b, bt, &s))
                });
            }
            Cmd::Stroke {
                style,
                transform,
                brush,
                brush_transform,
                shape,
            } => {
                let t = base * affine(transform);
                let bt = brush_transform.as_ref().map(affine);
                with_brush!(brush, cache, |b| {
                    with_shape!(shape, |s| scene.stroke(style, t, b, bt, &s))
                });
            }
            Cmd::Glyphs(run) => {
                let Some(blob) = cache.fonts.get(&run.font_id) else {
                    continue;
                };
                let font = FontData::new(blob.clone(), run.font_index);
                let t = base * affine(&run.transform);
                let gt = run.glyph_transform.as_ref().map(affine);
                let style: StyleRef<'_> = match &run.style {
                    StyleData::Fill(f) => StyleRef::Fill(*f),
                    StyleData::Stroke(s) => StyleRef::Stroke(s),
                };
                let embolden = kurbo::Vec2::new(run.embolden[0], run.embolden[1]);
                with_brush!(&run.brush, cache, |b| scene.draw_glyphs(
                    &font,
                    run.font_size,
                    run.hint,
                    &run.coords,
                    embolden,
                    style,
                    b,
                    run.brush_alpha,
                    t,
                    gt,
                    run.glyphs.iter().copied(),
                ));
            }
            Cmd::BoxShadow {
                transform,
                rect,
                color,
                radius,
                std_dev,
            } => {
                scene.draw_box_shadow(
                    base * affine(transform),
                    Rect::new(rect[0], rect[1], rect[2], rect[3]),
                    *color,
                    *radius,
                    *std_dev,
                );
            }
        }
    }
}

#[allow(dead_code)]
fn _assert_style_is_used(_: Style) {}
