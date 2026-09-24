//! Generates `$OUT_DIR/js_layer.rs`: the list of JS layer files (`js/*.js`, sorted by
//! file name) embedded with `include_str!`, so newly added layer files are picked up
//! without touching Rust code.

use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let js_dir = manifest_dir.join("js");
    // Re-run when files are added/removed (directory mtime) or edited.
    println!("cargo:rerun-if-changed={}", js_dir.display());

    let mut files: Vec<PathBuf> = match fs::read_dir(&js_dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "js"))
            .collect(),
        Err(_) => Vec::new(),
    };
    files.sort_by(|a, b| a.file_name().cmp(&b.file_name()));

    let mut out = String::new();
    out.push_str("/// JS layer files in execution order: (file name, source).\n");
    out.push_str("pub static JS_LAYER_FILES: &[(&str, &str)] = &[\n");
    for f in &files {
        println!("cargo:rerun-if-changed={}", f.display());
        let name = f.file_name().unwrap().to_string_lossy().into_owned();
        out.push_str(&format!(
            "    ({:?}, include_str!({:?})),\n",
            name,
            f.display().to_string()
        ));
    }
    out.push_str("];\n");

    let out_path = PathBuf::from(env::var("OUT_DIR").unwrap()).join("js_layer.rs");
    fs::write(out_path, out).unwrap();
}
