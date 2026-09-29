//! PATCH: external SVG sprites. An inline `<svg>` can reference an element of another
//! document, `<use href="/assets/icons.svg#menu">` (SVG 2 §5.6.2 "Processing the URL"): the
//! icon system of mydealz, GitHub's older octicons, most sprite generators. usvg only
//! resolves references inside the markup it is given, so the document is fetched once
//! (same-origin only, as Blink, Gecko and Ladybird do), indexed by `id`, and the elements a
//! `<use>` points to are copied into the `<defs>` of every `<svg>` that uses them.

use std::collections::{HashMap, HashSet};
use std::hash::{Hash, Hasher};
use std::sync::Arc;

use usvg::roxmltree;

use crate::layout::damage::ALL_DAMAGE;
use crate::net::{ResourceHandler, SvgSpriteHandler};
use crate::{BaseDocument, NodeId};

const SVG_NS: &str = "http://www.w3.org/2000/svg";
const XLINK_NS: &str = "http://www.w3.org/1999/xlink";
const XML_NS: &str = "http://www.w3.org/XML/1998/namespace";

/// Sprites requested per document, and the markup kept per sprite: a page cannot make the
/// engine fetch or index without bound with `<use>` elements.
const MAX_SPRITES: usize = 64;
const MAX_SPRITE_BYTES: usize = 8 * 1024 * 1024;
const MAX_INDEXED_BYTES: usize = 16 * 1024 * 1024;

pub(crate) enum SpriteState {
    /// Requested; the inline `<svg>` elements to rebuild when it arrives.
    Loading(Vec<NodeId>),
    Ready(Arc<SvgSprite>),
    /// Not an SVG document (or unreadable): not requested again.
    Failed,
}

/// The elements of an external SVG document that carry an `id`, serialized for the `<defs>`
/// of an inline `<svg>`.
#[derive(Debug)]
pub struct SvgSprite {
    /// Prepended to every id (and reference) so that sprites, and the page, cannot
    /// shadow each other's ids inside one `<svg>`.
    prefix: String,
    elements: HashMap<String, SpriteElement>,
    /// The sprite's own `<style>` elements: `.cls-1 { fill: … }` in generated sprites.
    styles: String,
}

#[derive(Debug)]
struct SpriteElement {
    markup: String,
    /// Ids of the sprite's elements this one refers to (`href="#g"`, `fill="url(#g)"`).
    refs: Vec<String>,
}

impl SvgSprite {
    pub(crate) fn parse(bytes: &[u8], url: &str) -> Result<Self, String> {
        if bytes.len() > MAX_SPRITE_BYTES {
            return Err(format!("SVG sprite too large ({} bytes)", bytes.len()));
        }
        let text = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
        let text = text.strip_prefix('\u{feff}').unwrap_or(text);
        // Illustrator/Inkscape exports carry a DOCTYPE with entity declarations.
        let options = roxmltree::ParsingOptions {
            allow_dtd: true,
            ..Default::default()
        };
        let doc =
            roxmltree::Document::parse_with_options(text, options).map_err(|e| e.to_string())?;
        let root = doc.root_element();
        if !is_svg_element(root) || root.tag_name().name() != "svg" {
            return Err(String::from("not an SVG document"));
        }

        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        url.hash(&mut hasher);
        let prefix = format!("sprite{:x}-", hasher.finish());

        let mut elements = HashMap::new();
        let mut styles = String::new();
        let mut indexed = 0;
        for node in root.descendants().filter(|n| is_svg_element(*n)) {
            if node.tag_name().name() == "style" {
                styles.push_str(&text[node.range()]);
                continue;
            }
            let Some(id) = node.attribute("id") else {
                continue;
            };
            if elements.contains_key(id) {
                continue;
            }
            let mut element = SpriteElement {
                markup: String::new(),
                refs: Vec::new(),
            };
            write_element(node, &prefix, &mut element.markup, &mut element.refs);
            indexed += element.markup.len();
            if indexed > MAX_INDEXED_BYTES {
                break;
            }
            elements.insert(id.to_string(), element);
        }
        Ok(Self {
            prefix,
            elements,
            styles,
        })
    }

    /// The id under which the sprite's element `id` appears in the markup that
    /// [`Self::copy_element`] writes.
    pub(crate) fn host_id(&self, id: &str) -> Option<String> {
        self.elements
            .contains_key(id)
            .then(|| format!("{}{id}", self.prefix))
    }

    /// Append the element `id` and the elements it references to `defs`. `copied` holds what
    /// an `<svg>` already received, so nothing is written twice.
    pub(crate) fn copy_element(&self, id: &str, copied: &mut HashSet<String>, defs: &mut String) {
        if !self.styles.is_empty() && copied.insert(format!("{}<style>", self.prefix)) {
            defs.push_str(&self.styles);
        }
        let mut queue = vec![id];
        while let Some(id) = queue.pop() {
            let Some(element) = self.elements.get(id) else {
                continue;
            };
            if !copied.insert(format!("{}{id}", self.prefix)) {
                continue;
            }
            defs.push_str(&element.markup);
            queue.extend(element.refs.iter().map(String::as_str));
        }
    }
}

fn is_svg_element(node: roxmltree::Node) -> bool {
    node.is_element() && node.tag_name().namespace() == Some(SVG_NS)
}

/// Serialize an element of a sprite for the markup of an inline `<svg>` (whose root declares
/// the SVG and XLink namespaces): its ids and the references to them get `prefix`.
fn write_element(node: roxmltree::Node, prefix: &str, out: &mut String, refs: &mut Vec<String>) {
    let name = node.tag_name().name();
    out.push('<');
    out.push_str(name);
    for attr in node.attributes() {
        let qualified = match attr.namespace() {
            None => attr.name().to_string(),
            Some(XLINK_NS) => format!("xlink:{}", attr.name()),
            Some(XML_NS) => format!("xml:{}", attr.name()),
            // Editor metadata (`inkscape:`, `sodipodi:`), whose prefixes the host doesn't declare.
            Some(_) => continue,
        };
        let value = prefixed_value(&qualified, attr.value(), prefix, refs);
        out.push(' ');
        out.push_str(&qualified);
        out.push_str("=\"");
        html_escape::encode_double_quoted_attribute_to_string(&value, out);
        out.push('"');
    }
    out.push('>');
    for child in node.children() {
        if child.is_element() {
            // Foreign elements (`<metadata>` payloads, `<sodipodi:namedview>`) have no meaning here.
            if is_svg_element(child) {
                write_element(child, prefix, out, refs);
            }
        } else if let Some(text) = child.text() {
            html_escape::encode_text_to_string(text, out);
        }
    }
    out.push_str("</");
    out.push_str(name);
    out.push('>');
}

fn prefixed_value(name: &str, value: &str, prefix: &str, refs: &mut Vec<String>) -> String {
    if name == "id" {
        return format!("{prefix}{value}");
    }
    if matches!(name, "href" | "xlink:href") {
        if let Some(id) = value.strip_prefix('#') {
            refs.push(id.to_string());
            return format!("#{prefix}{id}");
        }
        return value.to_string();
    }
    if !value.contains("url(") {
        return value.to_string();
    }
    // `fill="url(#g)"`, `style="clip-path:url('#c')"`.
    let mut out = String::with_capacity(value.len() + prefix.len());
    let mut rest = value;
    while let Some(at) = rest.find("url(") {
        let (head, tail) = rest.split_at(at + 4);
        out.push_str(head);
        let tail_start = tail.trim_start_matches([' ', '"', '\'']);
        out.push_str(&tail[..tail.len() - tail_start.len()]);
        rest = tail_start;
        if let Some(id_and_rest) = rest.strip_prefix('#') {
            let end = id_and_rest
                .find([')', '"', '\'', ' '])
                .unwrap_or(id_and_rest.len());
            refs.push(id_and_rest[..end].to_string());
            out.push('#');
            out.push_str(prefix);
            rest = id_and_rest;
        }
    }
    out.push_str(rest);
    out
}

/// What a `<use href>` of an inline `<svg>` points to.
pub(crate) enum UseTarget {
    /// An element of this document, spelled with the document's own URL.
    SameDocument(String),
    /// An element of a sprite that has loaded.
    Sprite(Arc<SvgSprite>, String),
    /// A sprite that is loading, failed or is not allowed, or a URL without a fragment.
    Unavailable,
}

impl BaseDocument {
    /// Resolve the `href` of a `<use>` inside the inline `<svg>` `svg_id`. An external
    /// document is requested on first sight (the `<svg>` is rebuilt when it arrives).
    pub(crate) fn resolve_svg_use(&mut self, svg_id: NodeId, raw: &str) -> UseTarget {
        let raw = raw.trim();
        if raw.starts_with('#') {
            return UseTarget::Unavailable;
        }
        let Some(mut url) = self.document_base.resolve_relative(raw) else {
            return UseTarget::Unavailable;
        };
        let Some(id) = url.fragment() else {
            return UseTarget::Unavailable;
        };
        let id = percent_encoding::percent_decode_str(id)
            .decode_utf8_lossy()
            .into_owned();
        if self.url.is_same_document(&url) {
            return UseTarget::SameDocument(id);
        }
        // The fetch has mode "same-origin".
        if !matches!(url.scheme(), "http" | "https") || url.origin() != self.url.origin() {
            return UseTarget::Unavailable;
        }
        url.set_fragment(None);
        match self.svg_sprite(url, svg_id) {
            Some(sprite) => UseTarget::Sprite(sprite, id),
            None => UseTarget::Unavailable,
        }
    }

    fn svg_sprite(&mut self, url: url::Url, svg_id: NodeId) -> Option<Arc<SvgSprite>> {
        let key = url.as_str();
        match self.svg_sprites.get_mut(key) {
            Some(SpriteState::Ready(sprite)) => return Some(sprite.clone()),
            Some(SpriteState::Loading(waiting)) => {
                if !waiting.contains(&svg_id) {
                    waiting.push(svg_id);
                }
                return None;
            }
            Some(SpriteState::Failed) => return None,
            None => {}
        }
        if self.svg_sprites.len() >= MAX_SPRITES || self.net_provider.is_noop() {
            return None;
        }
        let key = key.to_string();
        self.svg_sprites
            .insert(key.clone(), SpriteState::Loading(vec![svg_id]));
        self.net_provider.fetch(
            self.id(),
            self.build_request(url),
            ResourceHandler::boxed(
                self.tx.clone(),
                self.id(),
                None,
                self.shell_provider.clone(),
                SvgSpriteHandler { url: key },
            ),
        );
        None
    }

    /// A sprite arrived: rebuild the inline `<svg>` elements that waited for it.
    pub(crate) fn apply_loaded_svg_sprite(&mut self, url: &str, sprite: Arc<SvgSprite>) {
        let state = SpriteState::Ready(sprite);
        let Some(SpriteState::Loading(waiting)) = self.svg_sprites.insert(url.to_string(), state)
        else {
            return;
        };
        for node_id in waiting {
            if let Some(node) = self.nodes.get_mut(node_id) {
                node.cache_mut().clear();
                node.insert_damage(ALL_DAMAGE);
            }
        }
    }

    pub(crate) fn fail_svg_sprite(&mut self, url: &str) {
        if let Some(state @ SpriteState::Loading(_)) = self.svg_sprites.get_mut(url) {
            *state = SpriteState::Failed;
        }
    }
}
