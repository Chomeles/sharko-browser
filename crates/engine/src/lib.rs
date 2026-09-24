//! Renderer process: document loading, DOM/CSS/layout (Blitz), JavaScript (V8, via the
//! `script` crate), input handling and painting into display lists.
//!
//! Also contains the CPU rasterizer used by the browser process for headless screenshots
//! and as the GPU-less fallback compositor.

pub mod decode;
pub mod host;
pub mod input;
pub mod raster;
pub mod renderer;

pub use renderer::{Renderer, RendererConfig, renderer_main};
