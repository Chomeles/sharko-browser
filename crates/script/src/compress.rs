//! `CompressionStream` / `DecompressionStream` (gzip, deflate, deflate-raw) on flate2.

use std::collections::HashMap;
use std::io::Write;

use flate2::Compression;
use flate2::write::{
    DeflateDecoder, DeflateEncoder, GzDecoder, GzEncoder, ZlibDecoder, ZlibEncoder,
};

use crate::cx::{Cx, JsErr, NResult, array_buffer_from_vec, bytes_of};

/// A streaming (de)compressor writing into a `Vec` that is drained after each chunk.
enum Coder {
    GzEnc(GzEncoder<Vec<u8>>),
    ZlibEnc(ZlibEncoder<Vec<u8>>),
    RawEnc(DeflateEncoder<Vec<u8>>),
    GzDec(GzDecoder<Vec<u8>>),
    ZlibDec(ZlibDecoder<Vec<u8>>),
    RawDec(DeflateDecoder<Vec<u8>>),
}

impl Coder {
    fn write(&mut self, data: &[u8]) -> std::io::Result<Vec<u8>> {
        macro_rules! go {
            ($c:expr) => {{
                $c.write_all(data)?;
                Ok(std::mem::take($c.get_mut()))
            }};
        }
        match self {
            Coder::GzEnc(c) => go!(c),
            Coder::ZlibEnc(c) => go!(c),
            Coder::RawEnc(c) => go!(c),
            Coder::GzDec(c) => go!(c),
            Coder::ZlibDec(c) => go!(c),
            Coder::RawDec(c) => go!(c),
        }
    }

    fn finish(self) -> std::io::Result<Vec<u8>> {
        match self {
            Coder::GzEnc(c) => c.finish(),
            Coder::ZlibEnc(c) => c.finish(),
            Coder::RawEnc(c) => c.finish(),
            Coder::GzDec(c) => c.finish(),
            Coder::ZlibDec(c) => c.finish(),
            Coder::RawDec(c) => c.finish(),
        }
    }
}

#[derive(Default)]
pub(crate) struct Coders {
    next: u32,
    live: HashMap<u32, Coder>,
}

/// `N.zCreate(format, compress)` -> handle (`format`: gzip, deflate, deflate-raw).
pub(crate) fn n_z_create(cx: &mut Cx) -> NResult {
    let format = cx.string(0)?;
    let compress = cx.bool(1);
    let level = Compression::default();
    let coder = match (format.as_str(), compress) {
        ("gzip", true) => Coder::GzEnc(GzEncoder::new(Vec::new(), level)),
        ("deflate", true) => Coder::ZlibEnc(ZlibEncoder::new(Vec::new(), level)),
        ("deflate-raw", true) => Coder::RawEnc(DeflateEncoder::new(Vec::new(), level)),
        ("gzip", false) => Coder::GzDec(GzDecoder::new(Vec::new())),
        ("deflate", false) => Coder::ZlibDec(ZlibDecoder::new(Vec::new())),
        ("deflate-raw", false) => Coder::RawDec(DeflateDecoder::new(Vec::new())),
        _ => return Err(JsErr::type_err(format!("Unsupported compression format: '{format}'"))),
    };
    let mut coders = cx.st.coders.borrow_mut();
    coders.next += 1;
    let id = coders.next;
    coders.live.insert(id, coder);
    cx.ret_f64(id as f64);
    Ok(())
}

fn data_err(e: std::io::Error) -> JsErr {
    JsErr::type_err(format!("The compressed data was not valid: {e}"))
}

/// `N.zWrite(handle, bytes)` -> ArrayBuffer of the output produced so far.
pub(crate) fn n_z_write(cx: &mut Cx) -> NResult {
    let id = cx.num(0) as u32;
    let v = cx.arg(1);
    let data = bytes_of(cx.scope, v).ok_or_else(|| JsErr::type_err("expected a BufferSource"))?;
    let out = {
        let mut coders = cx.st.coders.borrow_mut();
        let coder = coders
            .live
            .get_mut(&id)
            .ok_or_else(|| JsErr::type_err("the stream is closed"))?;
        match coder.write(&data) {
            Ok(out) => out,
            Err(e) => {
                coders.live.remove(&id);
                return Err(data_err(e));
            }
        }
    };
    let ab = array_buffer_from_vec(cx.scope, out);
    cx.ret_value(ab.into());
    Ok(())
}

/// `N.zFinish(handle)` -> ArrayBuffer of the remaining output (throws on truncated input).
pub(crate) fn n_z_finish(cx: &mut Cx) -> NResult {
    let id = cx.num(0) as u32;
    let coder = cx
        .st
        .coders
        .borrow_mut()
        .live
        .remove(&id)
        .ok_or_else(|| JsErr::type_err("the stream is closed"))?;
    let out = coder.finish().map_err(data_err)?;
    let ab = array_buffer_from_vec(cx.scope, out);
    cx.ret_value(ab.into());
    Ok(())
}

/// `N.zDrop(handle)`: the stream was aborted.
pub(crate) fn n_z_drop(cx: &mut Cx) -> NResult {
    let id = cx.num(0) as u32;
    cx.st.coders.borrow_mut().live.remove(&id);
    Ok(())
}
