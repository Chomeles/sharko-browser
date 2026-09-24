//! Native call context, error type, value conversion helpers and node id encoding.

use std::borrow::Cow;
use std::mem::MaybeUninit;

use blitz_dom::{BaseDocument, NodeId};

use crate::state::RuntimeState;

// ---------------------------------------------------------------------------------
// Node id <-> JS number
// ---------------------------------------------------------------------------------

/// Bits reserved for the slot index in the JS encoding of a node id.
const IDX_BITS: u32 = 24;
/// Largest reuse generation we can encode below 2^53.
const MAX_GEN: u64 = (1 << (53 - IDX_BITS)) - 2;

/// Encode a blitz [`NodeId`] as the JS number handed to the JS layer (never 0).
///
/// blitz node ids are slotmap keys: a 32-bit slot index and a 32-bit version that is
/// odd while the slot is occupied and grows by 2 each time the slot is reused.
/// `NodeId::as_u64()` is therefore always >= 2^32 (a heap number in V8) and would exceed
/// 2^53 after ~1M reuses of a slot. We encode `((version >> 1) << 24 | index) + 1`
/// instead: fresh slots map to small integers (V8 Smis, no allocation) and the encoding
/// stays exact for 2^28 reuses per slot and 16M live nodes.
///
/// Returns `None` for ids outside that range (never happens in practice).
pub fn node_id_to_js(id: NodeId) -> Option<f64> {
    let raw = id.as_u64();
    let idx = raw & 0xFFFF_FFFF;
    let version = raw >> 32;
    if idx >= (1 << IDX_BITS) || version & 1 == 0 {
        return None;
    }
    let generation = version >> 1;
    if generation > MAX_GEN {
        return None;
    }
    Some((((generation << IDX_BITS) | idx) + 1) as f64)
}

/// Decode a JS node id produced by [`node_id_to_js`]. `0` and malformed values yield
/// `None`. The result may still refer to a dropped node (check with `get_node`).
pub fn node_id_from_js(v: f64) -> Option<NodeId> {
    if !(1.0..9_007_199_254_740_992.0).contains(&v) || v.fract() != 0.0 {
        return None;
    }
    let v = v as u64 - 1;
    let idx = v & ((1 << IDX_BITS) - 1);
    let generation = v >> IDX_BITS;
    let version = (generation << 1) | 1;
    if version > u32::MAX as u64 {
        return None;
    }
    Some(NodeId::from_u64((version << 32) | idx))
}

// ---------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------

/// An error to be thrown into JS by a native.
#[derive(Debug)]
pub(crate) enum JsErr {
    /// A real `TypeError`.
    Type(Cow<'static, str>),
    /// A real `RangeError`.
    Range(Cow<'static, str>),
    /// `Error("<Name>: <message>")` — the JS layer maps the prefix to a DOMException.
    Dom(&'static str, Cow<'static, str>),
    /// A JS exception is already pending (e.g. thrown by a nested call).
    Thrown,
}

impl JsErr {
    pub(crate) fn dom(name: &'static str, msg: impl Into<Cow<'static, str>>) -> Self {
        JsErr::Dom(name, msg.into())
    }
    pub(crate) fn type_err(msg: impl Into<Cow<'static, str>>) -> Self {
        JsErr::Type(msg.into())
    }
    pub(crate) fn range(msg: impl Into<Cow<'static, str>>) -> Self {
        JsErr::Range(msg.into())
    }
    pub(crate) fn hierarchy(msg: impl Into<Cow<'static, str>>) -> Self {
        JsErr::Dom("HierarchyRequestError", msg.into())
    }
    pub(crate) fn not_found(msg: impl Into<Cow<'static, str>>) -> Self {
        JsErr::Dom("NotFoundError", msg.into())
    }
    pub(crate) fn invalid_node() -> Self {
        JsErr::Type(Cow::Borrowed("invalid node id"))
    }

    pub(crate) fn throw(self, scope: &mut v8::PinScope) {
        let exc = match self {
            JsErr::Thrown => return,
            JsErr::Type(m) => {
                let m = v8_str(scope, &m);
                v8::Exception::type_error(scope, m)
            }
            JsErr::Range(m) => {
                let m = v8_str(scope, &m);
                v8::Exception::range_error(scope, m)
            }
            JsErr::Dom(name, m) => {
                let s = format!("{name}: {m}");
                let m = v8_str(scope, &s);
                v8::Exception::error(scope, m)
            }
        };
        scope.throw_exception(exc);
    }
}

pub(crate) type NResult = Result<(), JsErr>;

// ---------------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------------

/// Create a V8 string (one-byte fast path for ASCII).
#[inline]
pub(crate) fn v8_str<'s>(scope: &v8::PinScope<'s, '_, ()>, s: &str) -> v8::Local<'s, v8::String> {
    let r = if s.len() <= 1024 && s.is_ascii() {
        v8::String::new_from_one_byte(scope, s.as_bytes(), v8::NewStringType::Normal)
    } else {
        v8::String::new_from_utf8(scope, s.as_bytes(), v8::NewStringType::Normal)
    };
    r.unwrap_or_else(|| v8::String::empty(scope))
}

/// Internalized one-byte string for property keys.
#[inline]
pub(crate) fn v8_key<'s>(scope: &v8::PinScope<'s, '_, ()>, s: &str) -> v8::Local<'s, v8::String> {
    v8::String::new_from_one_byte(scope, s.as_bytes(), v8::NewStringType::Internalized)
        .unwrap_or_else(|| v8::String::empty(scope))
}

/// ToString a value (may run user code for objects); `None` if it threw.
pub(crate) fn value_to_string(scope: &mut v8::PinScope, v: v8::Local<v8::Value>) -> Option<String> {
    if v.is_string() {
        let s: v8::Local<v8::String> = v.try_into().ok()?;
        return Some(s.to_rust_string_lossy(scope));
    }
    let s = v.to_string(scope)?;
    Some(s.to_rust_string_lossy(scope))
}

/// Convert a value to a number without invoking user code: numbers and booleans map
/// directly, everything else is `NaN`.
#[inline]
pub(crate) fn plain_number(v: v8::Local<v8::Value>) -> f64 {
    if v.is_int32() {
        v.int32_value_fast()
    } else if v.is_number() {
        // SAFETY: checked above.
        unsafe { v8::Local::<v8::Number>::cast_unchecked(v) }.value()
    } else if v.is_boolean() {
        if v.is_true() { 1.0 } else { 0.0 }
    } else {
        f64::NAN
    }
}

trait Int32Fast {
    fn int32_value_fast(&self) -> f64;
}
impl Int32Fast for v8::Local<'_, v8::Value> {
    #[inline]
    fn int32_value_fast(&self) -> f64 {
        // SAFETY: callers check `is_int32`.
        unsafe { v8::Local::<v8::Int32>::cast_unchecked(*self) }.value() as f64
    }
}

// ---------------------------------------------------------------------------------
// Native call context
// ---------------------------------------------------------------------------------

/// Everything a native needs: the V8 scope, arguments, return slot and runtime state.
pub(crate) struct Cx<'a, 's, 'i> {
    pub(crate) scope: &'a mut v8::PinScope<'s, 'i>,
    pub(crate) args: &'a v8::FunctionCallbackArguments<'s>,
    pub(crate) rv: v8::ReturnValue<'s, v8::Value>,
    pub(crate) st: &'a RuntimeState,
}

impl<'a, 's, 'i> Cx<'a, 's, 'i> {
    #[inline]
    pub(crate) fn arg(&self, i: i32) -> v8::Local<'s, v8::Value> {
        self.args.get(i)
    }

    #[inline]
    pub(crate) fn len(&self) -> i32 {
        self.args.length()
    }

    /// Numeric argument (non-numbers become NaN; no user code runs).
    #[inline]
    pub(crate) fn num(&self, i: i32) -> f64 {
        plain_number(self.arg(i))
    }

    /// Boolean argument (ToBoolean, never runs user code).
    #[inline]
    pub(crate) fn bool(&mut self, i: i32) -> bool {
        self.arg(i).boolean_value(self.scope)
    }

    /// String argument (ToString; `undefined`/`null` become "undefined"/"null").
    pub(crate) fn string(&mut self, i: i32) -> Result<String, JsErr> {
        let v = self.arg(i);
        value_to_string(self.scope, v).ok_or(JsErr::Thrown)
    }

    /// Optional string argument: `undefined`/`null` map to `None`.
    pub(crate) fn opt_string(&mut self, i: i32) -> Result<Option<String>, JsErr> {
        let v = self.arg(i);
        if v.is_null_or_undefined() {
            return Ok(None);
        }
        value_to_string(self.scope, v)
            .map(Some)
            .ok_or(JsErr::Thrown)
    }

    /// Run `f` with the string argument `i` borrowed (stack buffer for short strings).
    pub(crate) fn with_str<R>(&mut self, i: i32, f: impl FnOnce(&str) -> R) -> Result<R, JsErr> {
        let v = self.arg(i);
        let s: v8::Local<v8::String> = if v.is_string() {
            // SAFETY: checked above.
            unsafe { v8::Local::<v8::String>::cast_unchecked(v) }
        } else {
            v.to_string(self.scope).ok_or(JsErr::Thrown)?
        };
        let mut buf = [MaybeUninit::<u8>::uninit(); 256];
        let cow = s.to_rust_cow_lossy(self.scope, &mut buf);
        Ok(f(&cow))
    }

    /// Decode a node id argument against `doc`; errors (TypeError) for 0, malformed or
    /// dropped ids and for layout-internal (anonymous) nodes.
    #[inline]
    pub(crate) fn node(&self, doc: &BaseDocument, i: i32) -> Result<NodeId, JsErr> {
        let id = node_id_from_js(self.num(i)).ok_or_else(JsErr::invalid_node)?;
        match doc.get_node(id) {
            Some(n) if !n.is_anonymous() => Ok(id),
            _ => Err(JsErr::invalid_node()),
        }
    }

    /// Like [`Cx::node`] but `0`, `null` and `undefined` mean `None`.
    pub(crate) fn opt_node(&self, doc: &BaseDocument, i: i32) -> Result<Option<NodeId>, JsErr> {
        let v = self.arg(i);
        if v.is_null_or_undefined() {
            return Ok(None);
        }
        let n = plain_number(v);
        if n == 0.0 {
            return Ok(None);
        }
        self.node(doc, i).map(Some)
    }

    // --- return values ---

    #[inline]
    pub(crate) fn ret_undefined(&mut self) {
        self.rv.set_undefined();
    }
    #[inline]
    pub(crate) fn ret_null(&mut self) {
        self.rv.set_null();
    }
    #[inline]
    pub(crate) fn ret_bool(&mut self, b: bool) {
        self.rv.set_bool(b);
    }
    #[inline]
    pub(crate) fn ret_f64(&mut self, v: f64) {
        if v.fract() == 0.0
            && v >= i32::MIN as f64
            && v <= i32::MAX as f64
            && !(v == 0.0 && v.is_sign_negative())
        {
            self.rv.set_int32(v as i32);
        } else {
            self.rv.set_double(v);
        }
    }
    #[inline]
    pub(crate) fn ret_i32(&mut self, v: i32) {
        self.rv.set_int32(v);
    }
    #[inline]
    pub(crate) fn ret_str(&mut self, s: &str) {
        if s.is_empty() {
            self.rv.set_empty_string();
        } else {
            let v = v8_str(self.scope, s);
            self.rv.set(v.into());
        }
    }
    pub(crate) fn ret_opt_str(&mut self, s: Option<&str>) {
        match s {
            Some(s) => self.ret_str(s),
            None => self.rv.set_null(),
        }
    }
    #[inline]
    pub(crate) fn ret_value(&mut self, v: v8::Local<'s, v8::Value>) {
        self.rv.set(v);
    }

    /// Return a node id (marking it as exposed to JS) or 0.
    pub(crate) fn ret_node(&mut self, doc: &mut BaseDocument, id: Option<NodeId>) {
        match id {
            Some(id) => {
                crate::dom::expose(doc, id);
                self.ret_f64(node_id_to_js(id).unwrap_or(0.0));
            }
            None => self.rv.set_int32(0),
        }
    }

    /// Return an array of node ids (marking them exposed).
    pub(crate) fn ret_nodes(&mut self, doc: &mut BaseDocument, ids: &[NodeId]) {
        for &id in ids {
            crate::dom::expose(doc, id);
        }
        let arr = ids_array(self.scope, ids);
        self.rv.set(arr.into());
    }

    pub(crate) fn ret_f64s(&mut self, vals: &[f64]) {
        let arr = f64_array(self.scope, vals);
        self.rv.set(arr.into());
    }

    pub(crate) fn ret_strs<S: AsRef<str>>(&mut self, vals: &[S]) {
        let elems: Vec<v8::Local<v8::Value>> = vals
            .iter()
            .map(|s| v8_str(self.scope, s.as_ref()).into())
            .collect();
        let arr = v8::Array::new_with_elements(self.scope, &elems);
        self.rv.set(arr.into());
    }
}

/// JS number for a node id (0 for unencodable ids).
#[inline]
pub(crate) fn id_value<'s>(
    scope: &v8::PinScope<'s, '_, ()>,
    id: NodeId,
) -> v8::Local<'s, v8::Value> {
    num_value(scope, node_id_to_js(id).unwrap_or(0.0))
}

#[inline]
pub(crate) fn num_value<'s>(scope: &v8::PinScope<'s, '_, ()>, v: f64) -> v8::Local<'s, v8::Value> {
    if v.fract() == 0.0 && v >= i32::MIN as f64 && v <= i32::MAX as f64 {
        v8::Integer::new(scope, v as i32).into()
    } else {
        v8::Number::new(scope, v).into()
    }
}

pub(crate) fn ids_array<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    ids: &[NodeId],
) -> v8::Local<'s, v8::Array> {
    let elems: Vec<v8::Local<v8::Value>> = ids.iter().map(|&id| id_value(scope, id)).collect();
    v8::Array::new_with_elements(scope, &elems)
}

pub(crate) fn f64_array<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    vals: &[f64],
) -> v8::Local<'s, v8::Array> {
    let elems: Vec<v8::Local<v8::Value>> = vals.iter().map(|&v| num_value(scope, v)).collect();
    v8::Array::new_with_elements(scope, &elems)
}

/// Set `obj[key] = value` (data property, ignoring failures).
#[inline]
pub(crate) fn set_prop<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    key: &str,
    value: v8::Local<'s, v8::Value>,
) {
    let k = v8_key(scope, key);
    obj.set(scope, k.into(), value);
}

/// Read `obj[key]`.
pub(crate) fn get_prop<'s>(
    scope: &mut v8::PinScope<'s, '_>,
    obj: v8::Local<'s, v8::Object>,
    key: &str,
) -> Option<v8::Local<'s, v8::Value>> {
    let k = v8_key(scope, key);
    obj.get(scope, k.into())
}

/// Bytes of an ArrayBuffer / ArrayBufferView / string argument (strings as UTF-8).
pub(crate) fn bytes_of(scope: &mut v8::PinScope, v: v8::Local<v8::Value>) -> Option<Vec<u8>> {
    if v.is_array_buffer_view() {
        let view: v8::Local<v8::ArrayBufferView> = v.try_into().ok()?;
        let mut out = vec![0u8; view.byte_length()];
        view.copy_contents(&mut out);
        Some(out)
    } else if v.is_array_buffer() {
        let ab: v8::Local<v8::ArrayBuffer> = v.try_into().ok()?;
        let len = ab.byte_length();
        let mut out = vec![0u8; len];
        if let Some(ptr) = ab.data() {
            // SAFETY: the buffer is alive (held by the handle) and has `len` bytes.
            unsafe {
                std::ptr::copy_nonoverlapping(ptr.as_ptr() as *const u8, out.as_mut_ptr(), len)
            };
        }
        Some(out)
    } else if v.is_shared_array_buffer() {
        let ab: v8::Local<v8::SharedArrayBuffer> = v.try_into().ok()?;
        let bs = ab.get_backing_store();
        Some(bs.iter().map(|c| c.get()).collect())
    } else if v.is_string() {
        let s: v8::Local<v8::String> = v.try_into().ok()?;
        Some(s.to_rust_string_lossy(scope).into_bytes())
    } else {
        None
    }
}

/// Create an ArrayBuffer holding `data`.
pub(crate) fn array_buffer_from_vec<'s>(
    scope: &v8::PinScope<'s, '_, ()>,
    data: Vec<u8>,
) -> v8::Local<'s, v8::ArrayBuffer> {
    if data.is_empty() {
        return v8::ArrayBuffer::new(scope, 0);
    }
    let bs = v8::ArrayBuffer::new_backing_store_from_vec(data).make_shared();
    v8::ArrayBuffer::with_backing_store(scope, &bs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_roundtrip() {
        for (idx, version) in [
            (0u64, 1u64),
            (5, 1),
            (5, 3),
            (0xFF_FFFF, 7),
            (123, (1 << 29) - 1),
        ] {
            let id = NodeId::from_u64((version << 32) | idx);
            let js = node_id_to_js(id).unwrap();
            assert!((1.0..9_007_199_254_740_992.0).contains(&js));
            assert_eq!(node_id_from_js(js), Some(id));
        }
        // Fresh slots map to small integers.
        assert_eq!(node_id_to_js(NodeId::from_u64((1 << 32) | 41)), Some(42.0));
        assert_eq!(node_id_from_js(0.0), None);
        assert_eq!(node_id_from_js(1.5), None);
        assert_eq!(node_id_from_js(-3.0), None);
        assert_eq!(node_id_from_js(f64::NAN), None);
        // Even (vacant) versions are never produced.
        assert_eq!(node_id_to_js(NodeId::from_u64(2 << 32)), None);
    }
}
