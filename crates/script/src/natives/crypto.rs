//! Web Crypto primitives (`crypto.subtle`) on aws-lc-rs: digests, HMAC, AES-GCM/CBC/CTR/KW,
//! PBKDF2 and HKDF. Key handling, algorithm normalization and error mapping live in the JS
//! layer (`40_webapi.js`); these natives take raw key bytes.

use std::num::NonZeroU32;

use aws_lc_rs::{aead, cipher, digest, hkdf, hmac, key_wrap, pbkdf2};

use crate::cx::{Cx, JsErr, NResult, array_buffer_from_vec, bytes_of};

fn op_err(msg: &'static str) -> JsErr {
    JsErr::dom("OperationError", msg)
}

fn bytes_arg(cx: &mut Cx, i: i32) -> Result<Vec<u8>, JsErr> {
    let v = cx.arg(i);
    if v.is_null_or_undefined() {
        return Ok(Vec::new());
    }
    bytes_of(cx.scope, v).ok_or_else(|| JsErr::type_err("expected a BufferSource"))
}

fn ret_bytes(cx: &mut Cx, bytes: Vec<u8>) {
    let ab = array_buffer_from_vec(cx.scope, bytes);
    cx.ret_value(ab.into());
}

fn digest_alg(name: &str) -> Result<&'static digest::Algorithm, JsErr> {
    Ok(match name {
        "SHA-1" => &digest::SHA1_FOR_LEGACY_USE_ONLY,
        "SHA-256" => &digest::SHA256,
        "SHA-384" => &digest::SHA384,
        "SHA-512" => &digest::SHA512,
        _ => return Err(JsErr::dom("NotSupportedError", "Algorithm: Unrecognized name")),
    })
}

/// `N.cryptoDigest(hash, data)` -> ArrayBuffer.
pub(crate) fn n_crypto_digest(cx: &mut Cx) -> NResult {
    let hash = cx.string(0)?;
    let data = bytes_arg(cx, 1)?;
    let out = digest::digest(digest_alg(&hash)?, &data);
    ret_bytes(cx, out.as_ref().to_vec());
    Ok(())
}

fn hmac_alg(name: &str) -> Result<hmac::Algorithm, JsErr> {
    Ok(match name {
        "SHA-1" => hmac::HMAC_SHA1_FOR_LEGACY_USE_ONLY,
        "SHA-256" => hmac::HMAC_SHA256,
        "SHA-384" => hmac::HMAC_SHA384,
        "SHA-512" => hmac::HMAC_SHA512,
        _ => return Err(JsErr::dom("NotSupportedError", "Algorithm: Unrecognized name")),
    })
}

/// `N.cryptoHmac(hash, key, data)` -> ArrayBuffer (the MAC).
pub(crate) fn n_crypto_hmac(cx: &mut Cx) -> NResult {
    let hash = cx.string(0)?;
    let key = bytes_arg(cx, 1)?;
    let data = bytes_arg(cx, 2)?;
    let key = hmac::Key::new(hmac_alg(&hash)?, &key);
    let tag = hmac::sign(&key, &data);
    ret_bytes(cx, tag.as_ref().to_vec());
    Ok(())
}

/// `N.cryptoAes(mode, encrypt, key, iv, aad, tagBits, data)` -> ArrayBuffer.
/// `mode` is `GCM` (iv: 12 bytes, 128-bit tags), `CBC` (PKCS#7 padding), `CTR` (iv: the
/// 16-byte counter block) or `KW` (RFC 3394 key wrap; no iv).
pub(crate) fn n_crypto_aes(cx: &mut Cx) -> NResult {
    let mode = cx.string(0)?;
    let encrypt = cx.bool(1);
    let key = bytes_arg(cx, 2)?;
    let iv = bytes_arg(cx, 3)?;
    let aad = bytes_arg(cx, 4)?;
    let tag_bits = cx.num(5);
    let mut data = bytes_arg(cx, 6)?;
    let out = match mode.as_str() {
        "GCM" => {
            if tag_bits != 128.0 {
                return Err(JsErr::dom(
                    "NotSupportedError",
                    "AES-GCM: only 128-bit tags are supported",
                ));
            }
            let alg = match key.len() {
                16 => &aead::AES_128_GCM,
                32 => &aead::AES_256_GCM,
                _ => return Err(op_err("AES key data must be 128 or 256 bits")),
            };
            let key = aead::LessSafeKey::new(
                aead::UnboundKey::new(alg, &key).map_err(|_| op_err("invalid AES key"))?,
            );
            let nonce = aead::Nonce::try_assume_unique_for_key(&iv).map_err(|_| {
                JsErr::dom("NotSupportedError", "AES-GCM: the iv must be 96 bits")
            })?;
            let aad = aead::Aad::from(&aad[..]);
            if encrypt {
                key.seal_in_place_append_tag(nonce, aad, &mut data)
                    .map_err(|_| op_err("encryption failed"))?;
                data
            } else {
                let len = key
                    .open_in_place(nonce, aad, &mut data)
                    .map_err(|_| op_err("The operation failed for an operation-specific reason"))?
                    .len();
                data.truncate(len);
                data
            }
        }
        "CBC" | "CTR" => {
            let alg = match key.len() {
                16 => &cipher::AES_128,
                32 => &cipher::AES_256,
                _ => return Err(op_err("AES key data must be 128 or 256 bits")),
            };
            let iv: [u8; 16] = iv
                .as_slice()
                .try_into()
                .map_err(|_| op_err("The iv/counter must be 16 bytes"))?;
            let unbound = || {
                cipher::UnboundCipherKey::new(alg, &key).map_err(|_| op_err("invalid AES key"))
            };
            let fail = |_| op_err("The operation failed for an operation-specific reason");
            match (mode.as_str(), encrypt) {
                ("CBC", true) => {
                    let k = cipher::PaddedBlockEncryptingKey::cbc_pkcs7(unbound()?).map_err(fail)?;
                    k.less_safe_encrypt(
                        &mut data,
                        cipher::EncryptionContext::Iv128(iv.into()),
                    )
                    .map_err(fail)?;
                    data
                }
                ("CBC", false) => {
                    let k = cipher::PaddedBlockDecryptingKey::cbc_pkcs7(unbound()?).map_err(fail)?;
                    let len = k
                        .decrypt(&mut data, cipher::DecryptionContext::Iv128(iv.into()))
                        .map_err(fail)?
                        .len();
                    data.truncate(len);
                    data
                }
                (_, true) => {
                    let k = cipher::EncryptingKey::ctr(unbound()?).map_err(fail)?;
                    k.less_safe_encrypt(
                        &mut data,
                        cipher::EncryptionContext::Iv128(iv.into()),
                    )
                    .map_err(fail)?;
                    data
                }
                (_, false) => {
                    let k = cipher::DecryptingKey::ctr(unbound()?).map_err(fail)?;
                    k.decrypt(&mut data, cipher::DecryptionContext::Iv128(iv.into()))
                        .map_err(fail)?;
                    data
                }
            }
        }
        "KW" => {
            use key_wrap::KeyWrap;
            let block = match key.len() {
                16 => &key_wrap::AES_128,
                32 => &key_wrap::AES_256,
                _ => return Err(op_err("AES key data must be 128 or 256 bits")),
            };
            let kek = key_wrap::KeyEncryptionKey::new(block, &key)
                .map_err(|_| op_err("invalid AES key"))?;
            let fail = |_| op_err("The operation failed for an operation-specific reason");
            if data.len() % 8 != 0 || data.len() < 16 && encrypt || data.len() < 24 && !encrypt
            {
                return Err(op_err("AES-KW: invalid data length"));
            }
            let mut out = vec![0u8; data.len() + 8];
            let len = if encrypt {
                kek.wrap(&data, &mut out).map_err(fail)?.len()
            } else {
                kek.unwrap(&data, &mut out).map_err(fail)?.len()
            };
            out.truncate(len);
            out
        }
        _ => return Err(JsErr::dom("NotSupportedError", "Algorithm: Unrecognized name")),
    };
    ret_bytes(cx, out);
    Ok(())
}

/// `N.cryptoPbkdf2(hash, password, salt, iterations, bits)` -> ArrayBuffer.
pub(crate) fn n_crypto_pbkdf2(cx: &mut Cx) -> NResult {
    let hash = cx.string(0)?;
    let password = bytes_arg(cx, 1)?;
    let salt = bytes_arg(cx, 2)?;
    let iterations = cx.num(3);
    let bits = cx.num(4);
    let alg = match hash.as_str() {
        "SHA-1" => pbkdf2::PBKDF2_HMAC_SHA1,
        "SHA-256" => pbkdf2::PBKDF2_HMAC_SHA256,
        "SHA-384" => pbkdf2::PBKDF2_HMAC_SHA384,
        "SHA-512" => pbkdf2::PBKDF2_HMAC_SHA512,
        _ => return Err(JsErr::dom("NotSupportedError", "Algorithm: Unrecognized name")),
    };
    let iterations = NonZeroU32::new(iterations as u32)
        .filter(|_| iterations.is_finite() && iterations >= 1.0)
        .ok_or_else(|| op_err("PBKDF2 requires at least one iteration"))?;
    let len = (bits / 8.0) as usize;
    if len == 0 {
        return Err(op_err("PBKDF2: length must be a positive multiple of 8"));
    }
    let mut out = vec![0u8; len];
    pbkdf2::derive(alg, iterations, &salt, &password, &mut out);
    ret_bytes(cx, out);
    Ok(())
}

struct Len(usize);

impl hkdf::KeyType for Len {
    fn len(&self) -> usize {
        self.0
    }
}

/// `N.cryptoHkdf(hash, ikm, salt, info, bits)` -> ArrayBuffer.
pub(crate) fn n_crypto_hkdf(cx: &mut Cx) -> NResult {
    let hash = cx.string(0)?;
    let ikm = bytes_arg(cx, 1)?;
    let salt = bytes_arg(cx, 2)?;
    let info = bytes_arg(cx, 3)?;
    let bits = cx.num(4);
    let alg = match hash.as_str() {
        "SHA-1" => hkdf::HKDF_SHA1_FOR_LEGACY_USE_ONLY,
        "SHA-256" => hkdf::HKDF_SHA256,
        "SHA-384" => hkdf::HKDF_SHA384,
        "SHA-512" => hkdf::HKDF_SHA512,
        _ => return Err(JsErr::dom("NotSupportedError", "Algorithm: Unrecognized name")),
    };
    let len = (bits / 8.0) as usize;
    let mut out = vec![0u8; len];
    if len > 0 {
        let info = [&info[..]];
        hkdf::Salt::new(alg, &salt)
            .extract(&ikm)
            .expand(&info, Len(len))
            .and_then(|okm| okm.fill(&mut out))
            .map_err(|_| op_err("HKDF: the requested length is too large"))?;
    }
    ret_bytes(cx, out);
    Ok(())
}
