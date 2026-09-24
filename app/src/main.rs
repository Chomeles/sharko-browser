fn main() {
    let args: Vec<String> = std::env::args().collect();
    let html = std::fs::read_to_string(&args[1]).unwrap();
    let (buf, h) = engine::render_html_to_rgba(&html, "file:///tmp/", 1024, 768);
    engine::write_png(&args[2], &buf, 1024, h);
}
