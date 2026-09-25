//! PATCH: `<img>` source selection per the HTML "select an image source" algorithm
//! (`srcset` with `x`/`w` descriptors, `sizes`, `<picture>`/`<source>` with `media` and
//! `type`) and `loading="lazy"` (images load once they come near the viewport).
//!
//! Blitz only ever loaded `src`, so responsive images showed their tiny placeholder
//! (or nothing at all for `srcset`-only images), `<picture>` art direction was ignored,
//! and every image of a long page was fetched and decoded up front.

use crate::{BaseDocument, NodeId};
use markup5ever::local_name;
use style::context::QuirksMode;

/// How far outside the viewport a lazy image starts loading (Chromium: 1250px on fast
/// connections).
const LAZY_LOAD_MARGIN: f64 = 1250.0;

/// The image source chosen for an `<img>`.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageSource {
    /// The resolved URL to load.
    pub url: String,
    /// The candidate's pixel density: natural dimensions are divided by it.
    pub density: f32,
}

#[derive(Debug, Clone, PartialEq)]
struct Candidate {
    url: String,
    density: Option<f32>,
    width: Option<u32>,
}

fn is_ws(c: char) -> bool {
    matches!(c, ' ' | '\t' | '\n' | '\x0c' | '\r')
}

/// Parses a `srcset` attribute
/// (https://html.spec.whatwg.org/multipage/images.html#parse-a-srcset-attribute).
fn parse_srcset(input: &str) -> Vec<Candidate> {
    let mut out = Vec::new();
    let mut rest = input;
    loop {
        rest = rest.trim_start_matches(|c: char| is_ws(c) || c == ',');
        if rest.is_empty() {
            return out;
        }
        let end = rest.find(is_ws).unwrap_or(rest.len());
        let mut url = &rest[..end];
        rest = &rest[end..];
        let mut descriptors: Vec<String> = Vec::new();
        if url.ends_with(',') {
            url = url.trim_end_matches(',');
        } else {
            let mut current = String::new();
            let mut in_parens = false;
            let mut consumed = rest.len();
            for (i, c) in rest.char_indices() {
                if in_parens {
                    current.push(c);
                    in_parens = c != ')';
                    continue;
                }
                match c {
                    c if is_ws(c) => {
                        if !current.is_empty() {
                            descriptors.push(std::mem::take(&mut current));
                        }
                    }
                    ',' => {
                        consumed = i + 1;
                        break;
                    }
                    '(' => {
                        current.push(c);
                        in_parens = true;
                    }
                    _ => current.push(c),
                }
            }
            if !current.is_empty() {
                descriptors.push(current);
            }
            rest = &rest[consumed..];
        }
        if url.is_empty() {
            continue;
        }
        if let Some(candidate) = parse_descriptors(url, &descriptors) {
            out.push(candidate);
        }
    }
}

fn parse_descriptors(url: &str, descriptors: &[String]) -> Option<Candidate> {
    let mut width = None;
    let mut density = None;
    let mut height = None;
    for d in descriptors {
        let (value, unit) = d.split_at(d.len() - d.chars().last()?.len_utf8());
        match unit {
            "w" if width.is_none() && density.is_none() => {
                width = Some(parse_positive_int(value)?);
            }
            "x" if width.is_none() && density.is_none() && height.is_none() => {
                density = Some(parse_non_negative_float(value)?);
            }
            "h" if height.is_none() && density.is_none() => {
                height = Some(parse_positive_int(value)?);
            }
            _ => return None,
        }
    }
    if height.is_some() && width.is_none() {
        return None;
    }
    Some(Candidate {
        url: url.to_string(),
        density,
        width,
    })
}

fn parse_positive_int(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse::<u32>().ok().filter(|n| *n > 0)
}

fn parse_non_negative_float(s: &str) -> Option<f32> {
    let valid = !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
        && !s.starts_with('+')
        && !s.ends_with('.');
    let v = valid.then(|| s.parse::<f32>().ok()).flatten()?;
    (v.is_finite() && v >= 0.0).then_some(v)
}

/// The MIME types of `<source type>` the image decoder handles.
fn is_supported_type(ty: &str) -> bool {
    let ty = ty.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    matches!(
        ty.as_str(),
        "" | "image/jpeg"
            | "image/jpg"
            | "image/pjpeg"
            | "image/png"
            | "image/apng"
            | "image/gif"
            | "image/webp"
            | "image/tiff"
            | "image/svg+xml"
    )
}

/// Chromium's candidate choice (`html_srcset_parser.cc`): the smallest density that
/// covers the device pixel ratio, rounding down between two candidates below their
/// geometric mean.
fn pick(candidates: &[(f32, &Candidate)], dpr: f32) -> usize {
    let mut i = 0;
    while i + 1 < candidates.len() {
        let next = candidates[i + 1].0;
        if next < dpr {
            i += 1;
            continue;
        }
        let current = candidates[i].0;
        let geometric_mean = (current * next).sqrt();
        if (dpr <= 1.0 && dpr > current) || dpr >= geometric_mean {
            return i + 1;
        }
        break;
    }
    i
}

impl BaseDocument {
    /// Evaluates a `sizes` attribute to CSS pixels (100vw when absent or invalid).
    fn source_size(&self, img: NodeId, sizes: Option<&str>) -> f32 {
        use style::parser::ParserContext;
        use style::stylesheets::{CssRuleType, Origin};
        use style::values::specified::source_size_list::SourceSizeList;
        use style_traits::ParsingMode;

        let mut sizes = sizes.unwrap_or("").trim();
        // `sizes="auto"` (lazy images): the width the image is laid out at.
        if let Some(after) = sizes
            .get(..4)
            .filter(|s| s.eq_ignore_ascii_case("auto"))
            .map(|_| sizes[4..].trim_start())
            .filter(|s| s.is_empty() || s.starts_with(','))
        {
            let width = self.nodes[img].final_layout().size.width;
            if width > 0.0 {
                return width;
            }
            sizes = after.trim_start_matches(',');
        }
        let url = self.url.url_extra_data();
        let ctx = ParserContext::new(
            Origin::Author,
            &url,
            Some(CssRuleType::Style),
            ParsingMode::DEFAULT,
            QuirksMode::NoQuirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut input = cssparser::ParserInput::new(sizes);
        let list = SourceSizeList::parse(&ctx, &mut cssparser::Parser::new(&mut input));
        list.evaluate(self.stylist.device(), QuirksMode::NoQuirks)
            .to_f32_px()
    }

    fn media_matches(&self, media: &str) -> bool {
        use style::parser::ParserContext;
        use style::stylesheets::{CssRuleType, CustomMediaEvaluator, Origin};
        use style_traits::ParsingMode;

        let media = media.trim();
        if media.is_empty() {
            return true;
        }
        let url = self.url.url_extra_data();
        let mut ctx = ParserContext::new(
            Origin::Author,
            &url,
            Some(CssRuleType::Media),
            ParsingMode::DEFAULT,
            QuirksMode::NoQuirks,
            Default::default(),
            None,
            None,
            Default::default(),
        );
        let mut input = cssparser::ParserInput::new(media);
        let list = style::media_queries::MediaList::parse(
            &mut ctx,
            &mut cssparser::Parser::new(&mut input),
        );
        list.evaluate(
            self.stylist.device(),
            QuirksMode::NoQuirks,
            &mut CustomMediaEvaluator::none(),
        )
    }

    /// Whether the image's source depends on the viewport (`w` descriptors, `sizes`,
    /// `<source media>`), so that it is re-selected when the viewport changes.
    pub(crate) fn image_source_is_responsive(&self, img: NodeId) -> bool {
        let node = &self.nodes[img];
        node.attr(local_name!("srcset")).is_some()
            || node.parent.is_some_and(|p| {
                self.nodes[p].data.is_element_with_tag_name(&local_name!("picture"))
            })
    }

    /// Selects the source of an `<img>`: its `<picture>`'s first matching `<source>`,
    /// else its own `srcset` (with `src` as the 1x candidate), else `src`. `None` when
    /// there is nothing to load.
    pub fn select_image_source(&self, img: NodeId) -> Option<ImageSource> {
        let node = self.nodes.get(img)?;
        let dpr = self.viewport.scale();

        let mut chosen: Option<(Vec<Candidate>, NodeId)> = None;
        if let Some(parent) = node.parent.filter(|p| {
            self.nodes[*p].data.is_element_with_tag_name(&local_name!("picture"))
        }) {
            for &child in &self.nodes[parent].children {
                if child == img {
                    break;
                }
                let source = &self.nodes[child];
                if !source.data.is_element_with_tag_name(&local_name!("source")) {
                    continue;
                }
                let Some(srcset) = source.attr(local_name!("srcset")) else {
                    continue;
                };
                let candidates = parse_srcset(srcset);
                if candidates.is_empty()
                    || !source.attr(local_name!("media")).is_none_or(|m| self.media_matches(m))
                    || !source.attr(local_name!("type")).is_none_or(is_supported_type)
                {
                    continue;
                }
                chosen = Some((candidates, child));
                break;
            }
        }

        let (candidates, sizes_from) = match chosen {
            Some(c) => c,
            None => {
                let src = node.attr(local_name!("src")).filter(|s| !s.trim().is_empty());
                let mut candidates = node
                    .attr(local_name!("srcset"))
                    .map(parse_srcset)
                    .unwrap_or_default();
                if let Some(src) = src {
                    if !candidates
                        .iter()
                        .any(|c| c.width.is_some() || c.density == Some(1.0))
                    {
                        candidates.push(Candidate {
                            url: src.trim().to_string(),
                            density: Some(1.0),
                            width: None,
                        });
                    }
                }
                (candidates, img)
            }
        };
        if candidates.is_empty() {
            return None;
        }

        let needs_size = candidates.iter().any(|c| c.width.is_some());
        let source_size = if needs_size {
            self.source_size(img, self.nodes[sizes_from].attr(local_name!("sizes")))
                .max(f32::EPSILON)
        } else {
            1.0
        };
        let mut densities: Vec<(f32, &Candidate)> = candidates
            .iter()
            .map(|c| {
                let density = match (c.density, c.width) {
                    (Some(d), _) => d,
                    (None, Some(w)) => w as f32 / source_size,
                    (None, None) => 1.0,
                };
                (density, c)
            })
            .collect();
        densities.sort_by(|a, b| a.0.total_cmp(&b.0));
        densities.dedup_by(|b, a| a.0 == b.0);
        let (density, candidate) = densities[pick(&densities, dpr)];
        Some(ImageSource {
            url: self.resolve_url(&candidate.url).to_string(),
            density: if density > 0.0 { density } else { 1.0 },
        })
    }

    /// (Re)selects an `<img>`'s source and loads it, or leaves a lazy image for
    /// [`Self::update_image_loads`] to load once it is near the viewport.
    pub(crate) fn load_image(&mut self, img: NodeId) {
        if self.is_lazy_image(img) {
            self.lazy_images.insert(img);
            // Paint once it is laid out, which checks the distance to the viewport.
            self.shell_provider.request_redraw();
            return;
        }
        self.lazy_images.remove(&img);
        self.start_image_load(img);
    }

    pub(crate) fn start_image_load(&mut self, img: NodeId) {
        use crate::net::{ImageHandler, ResourceHandler};
        use crate::node::{ImageData, SpecialElementData};
        use crate::util::ImageType;

        let Some(source) = self.select_image_source(img) else {
            // Nothing to show: drop the previous image (and `error` for `src=""`).
            self.image_sources.remove(&img);
            self.image_loaded_src.remove(&img);
            let node = &mut self.nodes[img];
            let empty_src = node.attr(local_name!("src")).is_some_and(|s| s.trim().is_empty())
                && node.attr(local_name!("srcset")).is_none();
            if let Some(el) = node.element_data_mut() {
                if matches!(el.special_data, SpecialElementData::Image(_)) {
                    el.special_data = SpecialElementData::Image(Box::new(ImageData::None));
                    node.cache_mut().clear();
                    node.insert_damage(crate::layout::damage::ALL_DAMAGE);
                }
            }
            if empty_src && node.flags.is_in_document() {
                self.element_load_events.push((img, false));
            }
            return;
        };
        let url = source.url.clone();
        if self.image_sources.get(&img).is_some_and(|s| s.density != source.density) {
            let node = &mut self.nodes[img];
            node.cache_mut().clear();
            node.insert_damage(crate::layout::damage::ALL_DAMAGE);
        }
        self.image_sources.insert(img, source);

        if let Some(cached_image) = self.image_cache.get(&url) {
            let cached_image = cached_image.clone();
            let already_loaded = matches!(
                self.nodes[img].element_data().map(|e| &e.special_data),
                Some(SpecialElementData::Image(_))
            ) && self.image_loaded_src.get(&img) == Some(&url);
            let node = &mut self.nodes[img];
            let el = node.element_data_mut().unwrap();
            el.special_data = SpecialElementData::Image(Box::new(cached_image));
            node.cache_mut().clear();
            node.insert_damage(crate::layout::damage::ALL_DAMAGE);
            // A `load` event once per source (a detached image loaded before insertion
            // already fired it for this URL).
            if !already_loaded {
                self.image_loaded_src.insert(img, url);
                self.element_load_events.push((img, true));
            }
            return;
        }

        if let Some(waiting_list) = self.pending_images.get_mut(&url) {
            if !waiting_list
                .iter()
                .any(|(id, ty)| *id == img && matches!(ty, ImageType::Image))
            {
                waiting_list.push((img, ImageType::Image));
            }
            return;
        }

        let Ok(parsed) = url::Url::parse(&url) else {
            return;
        };
        self.pending_images
            .insert(url.clone(), vec![(img, ImageType::Image)]);
        self.net_provider.fetch(
            self.id(),
            self.build_request(parsed),
            ResourceHandler::boxed(
                self.tx.clone(),
                self.id(),
                None, // Handled via `pending_images`.
                self.shell_provider.clone(),
                ImageHandler::new(ImageType::Image, url),
            ),
        );
    }

    /// The URL of the source an `<img>` requested (`currentSrc`).
    pub fn image_current_src(&self, img: NodeId) -> Option<&str> {
        self.image_sources.get(&img).map(|s| s.url.as_str())
    }

    /// The pixel density of the image an `<img>` displays (1 unless it came from a
    /// `srcset` candidate).
    pub fn image_density(&self, img: NodeId) -> f32 {
        self.image_sources.get(&img).map_or(1.0, |s| s.density)
    }

    /// Whether an `<img>` defers loading until it is near the viewport.
    pub(crate) fn is_lazy_image(&self, img: NodeId) -> bool {
        let node = &self.nodes[img];
        node.flags.is_in_document()
            && node
                .attr(local_name!("loading"))
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("lazy"))
    }

    /// Whether a lazy `<img>` is rendered and within [`LAZY_LOAD_MARGIN`] of the
    /// viewport.
    fn lazy_image_is_near_viewport(&self, img: NodeId) -> bool {
        let mut cur = Some(img);
        while let Some(id) = cur {
            let node = &self.nodes[id];
            if node.is_element() {
                match node.primary_styles() {
                    Some(s) if s.get_box().display.is_none() => return false,
                    None => return false,
                    _ => {}
                }
            }
            cur = node.parent;
        }
        let Some(rect) = self.get_client_bounding_rect(img) else {
            return false;
        };
        let scale = self.viewport.scale_f64();
        let vw = self.viewport.window_size.0 as f64 / scale;
        let vh = self.viewport.window_size.1 as f64 / scale;
        rect.x <= vw + LAZY_LOAD_MARGIN
            && rect.x + rect.width >= -LAZY_LOAD_MARGIN
            && rect.y <= vh + LAZY_LOAD_MARGIN
            && rect.y + rect.height >= -LAZY_LOAD_MARGIN
    }

    /// Starts loading the lazy images that came near the viewport (after layout), and
    /// re-selects responsive image sources after a viewport change.
    pub(crate) fn update_image_loads(&mut self) {
        if std::mem::take(&mut self.image_sources_viewport_dirty) {
            let responsive: Vec<NodeId> = self
                .image_sources
                .keys()
                .copied()
                .filter(|&id| self.nodes.get(id).is_some() && self.image_source_is_responsive(id))
                .collect();
            for id in responsive {
                let current = self.image_sources.get(&id).map(|s| s.url.clone());
                if self.select_image_source(id).map(|s| s.url) != current {
                    self.load_image(id);
                }
            }
        }
        if self.lazy_images.is_empty() {
            return;
        }
        let mut lazy = std::mem::take(&mut self.lazy_images);
        let mut due: Vec<NodeId> = Vec::new();
        lazy.retain(|&id| {
            let alive = self.nodes.get(id).is_some_and(|n| n.flags.is_in_document());
            let near = alive && (!self.is_lazy_image(id) || self.lazy_image_is_near_viewport(id));
            if near {
                due.push(id);
            }
            alive && !near
        });
        // Images queued while loading these stay queued.
        lazy.extend(self.lazy_images.drain());
        self.lazy_images = lazy;
        if due.is_empty() {
            return;
        }
        for id in due {
            self.start_image_load(id);
        }
        // Cached images apply right away and need a new frame.
        self.shell_provider.request_redraw();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn urls(s: &str) -> Vec<(String, Option<f32>, Option<u32>)> {
        parse_srcset(s)
            .into_iter()
            .map(|c| (c.url, c.density, c.width))
            .collect()
    }

    #[test]
    fn srcset_parsing() {
        assert_eq!(
            urls("a.jpg 1x, b.jpg 2x"),
            vec![("a.jpg".into(), Some(1.0), None), ("b.jpg".into(), Some(2.0), None)]
        );
        assert_eq!(
            urls("  a.jpg 320w,b.jpg 640w ,\n c.jpg"),
            vec![
                ("a.jpg".into(), None, Some(320)),
                ("b.jpg".into(), None, Some(640)),
                ("c.jpg".into(), None, None)
            ]
        );
        // Commas inside URLs, trailing commas, invalid descriptors.
        assert_eq!(
            urls("data:image/png;base64,AAA= 1x,x.png,, y.png 2q, z.png 1.5x"),
            vec![
                ("data:image/png;base64,AAA=".into(), Some(1.0), None),
                ("x.png".into(), None, None),
                ("z.png".into(), Some(1.5), None)
            ]
        );
        assert_eq!(urls("a.png 100w 2x, b.png 0w, c.png 10h"), vec![]);
        assert_eq!(
            urls("img.jpg 100w (x, y), n.jpg"),
            vec![("n.jpg".into(), None, None)]
        );
        assert_eq!(urls("a.png .5x"), vec![("a.png".into(), Some(0.5), None)]);
    }

    #[test]
    fn candidate_choice() {
        let c = Candidate {
            url: String::new(),
            density: None,
            width: None,
        };
        let set = |ds: &[f32]| ds.iter().map(|d| (*d, &c)).collect::<Vec<_>>();
        assert_eq!(pick(&set(&[1.0, 2.0]), 1.0), 0);
        assert_eq!(pick(&set(&[1.0, 2.0]), 2.0), 1);
        assert_eq!(pick(&set(&[1.0, 2.0]), 1.25), 0);
        assert_eq!(pick(&set(&[1.0, 2.0]), 1.5), 1);
        assert_eq!(pick(&set(&[0.5, 1.2]), 1.0), 1);
        assert_eq!(pick(&set(&[1.2, 2.4]), 1.0), 0);
        assert_eq!(pick(&set(&[0.25, 0.5]), 1.0), 1);
        assert_eq!(pick(&set(&[0.3, 0.6, 1.25, 2.5]), 1.0), 2);
    }

    #[test]
    fn source_types() {
        assert!(is_supported_type("image/webp"));
        assert!(is_supported_type("IMAGE/JPEG; codecs=x"));
        assert!(!is_supported_type("image/avif"));
        assert!(!is_supported_type("image/jxl"));
    }
}
