//! SVG image data and CSS intrinsic sizing for SVG.

use std::sync::Arc;

use usvg::roxmltree;

/// Dimensions declared on the root `<svg>` element, before any resolution.
///
/// Unlike [`usvg::Tree::size`], which always produces a concrete size, this
/// preserves what the SVG actually declared: absent attributes are `None` and
/// percentage lengths are kept unresolved.
#[derive(Debug, Clone, Copy, Default)]
pub struct SvgIntrinsicDimensions {
    /// The root `width` attribute, if declared. Percentages are unresolved.
    pub width: Option<svgtypes::Length>,
    /// The root `height` attribute, if declared. Percentages are unresolved.
    pub height: Option<svgtypes::Length>,
    /// The root `viewBox` width/height, if declared and valid.
    pub view_box_size: Option<(f32, f32)>,
    /// Whether the root declared a `viewBox` with a zero width or height,
    /// which disables rendering of the element per the SVG spec.
    pub degenerate_view_box: bool,
}

impl SvgIntrinsicDimensions {
    /// Extract the `width`/`height`/`viewBox` attributes declared on the root
    /// element of an already-parsed SVG document, with absent attributes as
    /// `None` and percentages unresolved. [`usvg::Tree`] does not preserve
    /// these (it always resolves to a concrete size), so they are read from
    /// the XML document here.
    pub fn from_xmltree(doc: &roxmltree::Document) -> Self {
        let root = doc.root_element();

        let parse_length = |name: &str| -> Option<svgtypes::Length> {
            root.attribute(name)?.parse::<svgtypes::Length>().ok()
        };
        // Parsed manually rather than via `svgtypes::ViewBox`, which rejects
        // zero sizes: a zero `viewBox` width/height is distinguished from an
        // invalid `viewBox` as it disables rendering of the element.
        let view_box_dims = root.attribute("viewBox").and_then(|s| {
            let mut numbers = svgtypes::NumberListParser::from(s);
            let _x = numbers.next()?.ok()?;
            let _y = numbers.next()?.ok()?;
            let w = numbers.next()?.ok()? as f32;
            let h = numbers.next()?.ok()? as f32;
            (numbers.next().is_none() && w.is_finite() && h.is_finite() && w >= 0.0 && h >= 0.0)
                .then_some((w, h))
        });
        let view_box_size = view_box_dims.filter(|&(w, h)| w > 0.0 && h > 0.0);
        let degenerate_view_box = view_box_dims.is_some_and(|(w, h)| w == 0.0 || h == 0.0);

        Self {
            width: parse_length("width"),
            height: parse_length("height"),
            view_box_size,
            degenerate_view_box,
        }
    }
}

/// A parsed SVG image.
///
/// usvg always resolves the root `<svg>` to a concrete [`usvg::Tree::size`],
/// falling back to the `viewBox` size when `width`/`height` are absent or given
/// as percentages. For CSS sizing purposes, however, such an SVG has *no*
/// intrinsic width/height (only an intrinsic aspect ratio). The accessors on
/// this type resolve the CSS intrinsic dimensions from the declared root
/// attributes, which are captured at parse time.
#[derive(Debug, Clone)]
pub struct SvgImageData {
    /// The parsed SVG tree.
    pub tree: Arc<usvg::Tree>,
    /// The dimensions declared on the root `<svg>` element.
    pub intrinsic_dimensions: SvgIntrinsicDimensions,
}

impl SvgImageData {
    /// Parse an SVG image from raw data, capturing both the rendered
    /// [`usvg::Tree`] and the declared root dimensions from a single XML
    /// parse.
    ///
    /// Like [`usvg::Tree::from_data`], gzip-compressed data (SVGZ) is
    /// decompressed first.
    pub fn from_data(data: &[u8], options: &usvg::Options) -> Result<Self, usvg::Error> {
        // Gzip magic bytes, matching the SVGZ detection in `usvg::Tree::from_data`.
        let decompressed;
        let data = if data.starts_with(&[0x1f, 0x8b]) {
            decompressed = usvg::decompress_svgz(data)?;
            decompressed.as_slice()
        } else {
            data
        };

        let text = std::str::from_utf8(data).map_err(|_| usvg::Error::NotAnUtf8Str)?;
        // PATCH: usvg paints `color(display-p3 …)` black; rewrite such colors as sRGB.
        // PATCH: usvg only knows the exact spelling `currentColor` (CSS keywords are
        // case-insensitive; Stylo serializes `currentcolor`).
        let rewritten;
        let text = if text.contains("color(") || has_lowercase_currentcolor(text) {
            rewritten = fix_current_color(&rewrite_css_color_functions(text));
            rewritten.as_str()
        } else {
            text
        };
        let xml_options = roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        };
        let doc = roxmltree::Document::parse_with_options(text, xml_options)
            .map_err(usvg::Error::ParsingFailed)?;
        let tree = usvg::Tree::from_xmltree(&doc, options)?;
        Ok(Self {
            tree: Arc::new(tree),
            intrinsic_dimensions: SvgIntrinsicDimensions::from_xmltree(&doc),
        })
    }

    /// The intrinsic width in CSS px, present only when the root `<svg>`
    /// declared an absolute (non-percentage) `width`.
    pub fn intrinsic_width(&self) -> Option<f32> {
        use svgtypes::LengthUnit;
        let declared = self
            .intrinsic_dimensions
            .width
            .is_some_and(|len| len.unit != LengthUnit::Percent);
        declared.then(|| self.tree.size().width())
    }

    /// The intrinsic height in CSS px, present only when the root `<svg>`
    /// declared an absolute (non-percentage) `height`.
    pub fn intrinsic_height(&self) -> Option<f32> {
        use svgtypes::LengthUnit;
        let declared = self
            .intrinsic_dimensions
            .height
            .is_some_and(|len| len.unit != LengthUnit::Percent);
        declared.then(|| self.tree.size().height())
    }

    /// The aspect ratio of the root `<svg>`'s `viewBox`, if it declares one.
    pub fn viewbox_aspect_ratio(&self) -> Option<f32> {
        self.intrinsic_dimensions.view_box_size.map(|(w, h)| w / h)
    }

    /// The root `width` attribute resolved against a containing block width:
    /// percentages resolve against the containing block (`None` if it is
    /// indefinite) and an absent attribute is `None`.
    ///
    /// This is only appropriate for an inline `<svg>` element, where the
    /// attributes behave as presentation attributes. SVG used as an image
    /// (e.g. `<img src>` or a background) must use [`Self::intrinsic_width`],
    /// as its intrinsic dimensions are context-free per CSS.
    pub fn resolved_width(&self, container_width: Option<f32>) -> Option<f32> {
        use svgtypes::LengthUnit;
        match self.intrinsic_dimensions.width {
            Some(len) if len.unit != LengthUnit::Percent => Some(self.tree.size().width()),
            Some(len) => container_width.map(|cw| cw * (len.number as f32) / 100.0),
            None => None,
        }
    }

    /// The root `height` attribute resolved against a containing block height.
    /// See [`Self::resolved_width`].
    pub fn resolved_height(&self, container_height: Option<f32>) -> Option<f32> {
        use svgtypes::LengthUnit;
        match self.intrinsic_dimensions.height {
            Some(len) if len.unit != LengthUnit::Percent => Some(self.tree.size().height()),
            Some(len) => container_height.map(|ch| ch * (len.number as f32) / 100.0),
            None => None,
        }
    }

    /// The intrinsic aspect ratio of the SVG: the ratio of its declared
    /// `width`/`height` when both are absolute lengths, otherwise the
    /// `viewBox` ratio, otherwise the ratio of the resolved
    /// [`usvg::Tree::size`] (which is always non-zero).
    pub fn aspect_ratio(&self) -> f32 {
        match (self.intrinsic_width(), self.intrinsic_height()) {
            (Some(w), Some(h)) => w / h,
            _ => self.viewbox_aspect_ratio().unwrap_or_else(|| {
                let size = self.tree.size();
                size.width() / size.height()
            }),
        }
    }

    /// The intrinsic dimensions of the SVG resolved per CSS replaced element
    /// sizing: a missing dimension is computed from the declared one and the
    /// intrinsic aspect ratio; if neither is declared, the resolved
    /// [`usvg::Tree::size`] is used as a fallback.
    pub fn intrinsic_size(&self) -> (f32, f32) {
        let aspect_ratio = self.aspect_ratio();
        match (self.intrinsic_width(), self.intrinsic_height()) {
            (Some(w), Some(h)) => (w, h),
            (Some(w), None) => (w, w / aspect_ratio),
            (None, Some(h)) => (h * aspect_ratio, h),
            (None, None) => {
                // No intrinsic dimensions. If there is an intrinsic aspect ratio, apply
                // the CSS default sizing algorithm: contain within the default object
                // size of 300x150. Otherwise fall back to the resolved tree size.
                if self.viewbox_aspect_ratio().is_some() {
                    let scale = (300.0 / aspect_ratio).min(150.0);
                    (scale * aspect_ratio, scale)
                } else {
                    let size = self.tree.size();
                    (size.width(), size.height())
                }
            }
        }
    }
}

fn has_lowercase_currentcolor(text: &str) -> bool {
    text.as_bytes()
        .windows(12)
        .any(|w| w.eq_ignore_ascii_case(b"currentcolor") && w != b"currentColor")
}

/// Every ASCII-case spelling of `currentcolor` becomes `currentColor`.
fn fix_current_color(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    let mut copied = 0;
    while i + 12 <= bytes.len() {
        if bytes[i..i + 12].eq_ignore_ascii_case(b"currentcolor") {
            out.push_str(&text[copied..i]);
            out.push_str("currentColor");
            i += 12;
            copied = i;
        } else {
            i += 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

/// PATCH: replaces `color(display-p3 …)`, `color(srgb …)` and `color(srgb-linear …)` in
/// SVG source with `rgb()`/`rgba()`, which usvg understands.
fn rewrite_css_color_functions(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("color(") {
        // Not part of a longer identifier (e.g. `lighting-color(`, which isn't CSS anyway).
        let prefixed = rest[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
        let Some(len) = rest[start..].find(')') else { break };
        let inner = &rest[start + 6..start + len];
        out.push_str(&rest[..start]);
        match (!prefixed).then(|| color_function_to_rgb(inner)).flatten() {
            Some(rgb) => out.push_str(&rgb),
            None => out.push_str(&rest[start..=start + len]),
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out
}

fn color_function_to_rgb(inner: &str) -> Option<String> {
    let (channels, alpha) = match inner.split_once('/') {
        Some((c, a)) => (c, Some(a.trim())),
        None => (inner, None),
    };
    let mut parts = channels.split_whitespace();
    let space = parts.next()?.to_ascii_lowercase();
    let value = |s: Option<&str>| -> Option<f64> {
        let s = s?;
        if s.eq_ignore_ascii_case("none") {
            return Some(0.0);
        }
        match s.strip_suffix('%') {
            Some(p) => p.parse::<f64>().ok().map(|v| v / 100.0),
            None => s.parse::<f64>().ok(),
        }
    };
    let c = [value(parts.next())?, value(parts.next())?, value(parts.next())?];
    if parts.next().is_some() {
        return None;
    }
    let alpha = match alpha {
        Some(a) => value(Some(a))?.clamp(0.0, 1.0),
        None => 1.0,
    };
    let decode = |v: f64| {
        let a = v.abs();
        let l = if a <= 0.04045 { a / 12.92 } else { ((a + 0.055) / 1.055).powf(2.4) };
        l.copysign(v)
    };
    let linear_srgb = match space.as_str() {
        "srgb" => c.map(decode),
        "srgb-linear" => c,
        "display-p3" => {
            let [r, g, b] = c.map(decode);
            // Linear Display P3 -> XYZ (D65) -> linear sRGB.
            let x = 0.486_570_948_648_216_2 * r + 0.265_667_693_169_093_06 * g + 0.198_217_285_234_362_5 * b;
            let y = 0.228_974_564_069_748_8 * r + 0.691_738_521_836_506_4 * g + 0.079_286_914_093_745 * b;
            let z = 0.045_113_381_858_902_64 * g + 1.043_944_368_900_976 * b;
            [
                3.240_969_941_904_522_6 * x - 1.537_383_177_570_094 * y - 0.498_610_760_293_003_4 * z,
                -0.969_243_636_280_879_6 * x + 1.875_967_501_507_720_2 * y + 0.041_555_057_407_175_59 * z,
                0.055_630_079_696_993_66 * x - 0.203_976_958_888_976_52 * y + 1.056_971_514_242_878_6 * z,
            ]
        }
        _ => return None,
    };
    let encode = |l: f64| {
        let l = l.clamp(0.0, 1.0);
        let v = if l <= 0.003_130_8 { 12.92 * l } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 };
        (v * 255.0).round() as u8
    };
    let [r, g, b] = linear_srgb.map(encode);
    Some(if alpha >= 1.0 {
        format!("rgb({r},{g},{b})")
    } else {
        format!("rgba({r},{g},{b},{alpha})")
    })
}

#[cfg(test)]
mod color_tests {
    use super::rewrite_css_color_functions;

    #[test]
    fn wide_gamut_colors_become_srgb() {
        assert_eq!(
            rewrite_css_color_functions(r#"<path fill="color(display-p3 1 0 0)"/><g style="stroke:color(srgb 0 0.5 1 / 0.5)"/>"#),
            r#"<path fill="rgb(255,0,0)"/><g style="stroke:rgba(0,128,255,0.5)"/>"#
        );
        // Display P3 green is outside sRGB: clamped.
        assert_eq!(rewrite_css_color_functions("color(display-p3 0 1 0)"), "rgb(0,255,0)");
        // Same as Chromium (canvas getImageData).
        assert_eq!(rewrite_css_color_functions("color(display-p3 .1882 .6588 .2353)"), "rgb(0,171,37)");
        // Unknown spaces and malformed input stay as they are.
        assert_eq!(rewrite_css_color_functions("color(rec2020 1 0 0)"), "color(rec2020 1 0 0)");
        assert_eq!(rewrite_css_color_functions("color(display-p3 1 0"), "color(display-p3 1 0");
    }

    #[test]
    fn current_color_spellings() {
        use super::{fix_current_color, has_lowercase_currentcolor};
        assert!(has_lowercase_currentcolor(r#"<rect fill="currentcolor"/>"#));
        assert!(!has_lowercase_currentcolor(r#"<rect fill="currentColor"/>"#));
        assert_eq!(
            fix_current_color(r#"<a fill="CurrentColor" stroke="currentcolor">ü</a>"#),
            r#"<a fill="currentColor" stroke="currentColor">ü</a>"#
        );
    }
}
