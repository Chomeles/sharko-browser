//! The HTML "document base URL": relative subresource URLs (stylesheets, images, `srcset`,
//! preloads, iframes, `url()` in inline styles, links) resolve against the first
//! `<base href>` and not against the document URL, which stays what `location` reports.

use std::sync::{Arc, Mutex};

use blitz_dom::{DocumentConfig, LocalName, QualName, ns};
use blitz_html::HtmlDocument;
use blitz_traits::net::{NetHandler, NetProvider, Request};
use blitz_traits::shell::{ColorScheme, Viewport};

const PAGE: &str = "http://example.test/a/b/page.html";

#[derive(Default)]
struct Net(Mutex<Vec<String>>);

impl NetProvider for Net {
    fn fetch(&self, _doc_id: usize, request: Request, _handler: Box<dyn NetHandler>) {
        self.0.lock().unwrap().push(request.url.to_string());
    }
}

fn load(head: &str, body: &str) -> (HtmlDocument, Arc<Net>) {
    let net = Arc::new(Net::default());
    let html = format!("<!DOCTYPE html><html><head>{head}</head><body>{body}</body></html>");
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            viewport: Some(Viewport::new(100, 100, 1.0, ColorScheme::Light)),
            base_url: Some(PAGE.to_string()),
            net_provider: Some(net.clone()),
            html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
            ..Default::default()
        },
    );
    doc.resolve(0.0);
    (doc, net)
}

fn requested(net: &Net) -> Vec<String> {
    let mut v = net.0.lock().unwrap().clone();
    v.sort();
    v
}

fn href(value: &str) -> (QualName, &str) {
    (QualName::new(None, ns!(), LocalName::from("href")), value)
}

#[test]
fn subresources_resolve_against_base_href() {
    let (doc, net) = load(
        "<base href='http://cdn.test/root/'>\
         <link rel=stylesheet href='x.css'><link rel=preload href='p.js' as=script>",
        "<img src='i.png'><img srcset='s1.png 1x, s2.png 2x' src='fallback.png'>\
         <iframe src='f.html'></iframe>",
    );
    let got = requested(&net);
    for want in [
        "http://cdn.test/root/x.css",
        "http://cdn.test/root/p.js",
        "http://cdn.test/root/i.png",
        "http://cdn.test/root/f.html",
    ] {
        assert!(got.iter().any(|u| u == want), "{want} not requested: {got:?}");
    }
    assert!(got.iter().all(|u| !u.contains("example.test")), "{got:?}");
    // `location` keeps the document URL.
    assert_eq!(doc.base_url().as_str(), PAGE);
    assert_eq!(doc.document_base_url().as_str(), "http://cdn.test/root/");
}

#[test]
fn relative_and_root_relative_base_href_resolve_against_the_document_url() {
    let (doc, net) = load("<base href='/sub/../'><link rel=stylesheet href='x.css'>", "");
    assert_eq!(requested(&net), ["http://example.test/x.css"]);
    assert_eq!(doc.document_base_url().as_str(), "http://example.test/");
}

#[test]
fn without_a_base_the_document_url_is_the_base() {
    let (_doc, net) = load("<link rel=stylesheet href='x.css'>", "");
    assert_eq!(requested(&net), ["http://example.test/a/b/x.css"]);
}

#[test]
fn only_the_first_base_with_href_counts_and_target_only_bases_are_skipped() {
    let (_doc, net) = load(
        "<base target=_blank><base href='http://one.test/'><base href='http://two.test/'>\
         <link rel=stylesheet href='x.css'>",
        "",
    );
    assert_eq!(requested(&net), ["http://one.test/x.css"]);
}

#[test]
fn data_and_javascript_bases_fall_back_to_the_document_url() {
    for bad in ["data:text/plain,hi", "javascript:void(0)", "http://[bad"] {
        let (_doc, net) = load(&format!("<base href='{bad}'><link rel=stylesheet href='x.css'>"), "");
        assert_eq!(requested(&net), ["http://example.test/a/b/x.css"], "{bad}");
    }
}

#[test]
fn inline_style_urls_resolve_against_the_base() {
    let (_doc, net) = load(
        "<base href='http://cdn.test/img/'>",
        "<div style=\"background-image:url('bg.png');width:10px;height:10px\"></div>",
    );
    assert!(requested(&net).contains(&"http://cdn.test/img/bg.png".to_string()), "{:?}", requested(&net));
}

#[test]
fn srcdoc_documents_use_the_parents_base_url() {
    let (_doc, net) = load(
        "<base href='http://cdn.test/root/'>",
        "<iframe srcdoc=\"<img src='in.png'>\"></iframe>",
    );
    assert!(requested(&net).contains(&"http://cdn.test/root/in.png".to_string()), "{:?}", requested(&net));
}

#[test]
fn changing_removing_and_inserting_a_base_updates_it() {
    let (mut doc, _net) = load("<base href='http://one.test/'>", "");
    let base = doc.query_selector("base").unwrap().unwrap();
    doc.mutate().set_attribute(base, href("http://two.test/x/").0, "http://two.test/x/");
    assert_eq!(doc.document_base_url().as_str(), "http://two.test/x/");
    doc.mutate().clear_attribute(base, href("").0);
    assert_eq!(doc.document_base_url().as_str(), PAGE);
    doc.mutate().set_attribute(base, href("").0, "/top/");
    assert_eq!(doc.document_base_url().as_str(), "http://example.test/top/");
    doc.mutate().remove_node(base);
    assert_eq!(doc.document_base_url().as_str(), PAGE);
}
