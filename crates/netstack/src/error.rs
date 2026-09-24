//! Network errors, classified into Chrome-style `net::ERR_*` codes so that the browser
//! can show meaningful error pages.

use std::error::Error as StdError;
use std::fmt;
use std::io;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NetError {
    code: &'static str,
    detail: String,
}

impl NetError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn invalid_url(detail: impl Into<String>) -> Self {
        Self::new("ERR_INVALID_URL", detail)
    }

    pub fn unknown_scheme(scheme: &str) -> Self {
        Self::new("ERR_UNKNOWN_URL_SCHEME", format!("unsupported scheme `{scheme}:`"))
    }

    pub fn too_big() -> Self {
        Self::new("ERR_FILE_TOO_BIG", "response body exceeds the transport limit")
    }

    pub fn timed_out(detail: impl Into<String>) -> Self {
        Self::new("ERR_TIMED_OUT", detail)
    }

    /// Classifies a file-system error (file: URLs).
    pub fn from_io(err: &io::Error, what: &str) -> Self {
        let code = match err.kind() {
            io::ErrorKind::NotFound => "ERR_FILE_NOT_FOUND",
            io::ErrorKind::PermissionDenied => "ERR_ACCESS_DENIED",
            _ => "ERR_FAILED",
        };
        Self::new(code, format!("{what}: {err}"))
    }

    /// Classifies a reqwest/hyper/rustls error by walking its source chain.
    pub fn from_reqwest(err: &reqwest::Error) -> Self {
        let detail = error_chain(err);
        let mut source: Option<&(dyn StdError + 'static)> = Some(err);
        while let Some(e) = source {
            if let Some(tls) = e.downcast_ref::<rustls::Error>() {
                return Self::new(tls_code(tls), detail);
            }
            if let Some(ioe) = e.downcast_ref::<io::Error>() {
                let code = match ioe.kind() {
                    io::ErrorKind::ConnectionRefused => Some("ERR_CONNECTION_REFUSED"),
                    io::ErrorKind::ConnectionReset => Some("ERR_CONNECTION_RESET"),
                    io::ErrorKind::ConnectionAborted => Some("ERR_CONNECTION_ABORTED"),
                    io::ErrorKind::TimedOut => Some("ERR_TIMED_OUT"),
                    io::ErrorKind::HostUnreachable | io::ErrorKind::NetworkUnreachable => {
                        Some("ERR_ADDRESS_UNREACHABLE")
                    }
                    _ => None,
                };
                if let Some(code) = code {
                    return Self::new(code, detail);
                }
                // `io::Error::source()` skips the wrapped error itself (it returns the
                // wrapped error's source), and TLS stacks nest io::Errors: descend
                // explicitly.
                if let Some(inner) = ioe.get_ref() {
                    source = Some(inner);
                    continue;
                }
            }
            source = e.source();
        }
        let lower = detail.to_ascii_lowercase();
        let code = if err.is_timeout() {
            if err.is_connect() {
                "ERR_CONNECTION_TIMED_OUT"
            } else {
                "ERR_TIMED_OUT"
            }
        } else if lower.contains("dns error")
            || lower.contains("failed to lookup address")
            || lower.contains("name or service not known")
            || lower.contains("no such host")
        {
            "ERR_NAME_NOT_RESOLVED"
        } else if err.is_connect() {
            "ERR_CONNECTION_FAILED"
        } else if err.is_decode() {
            "ERR_CONTENT_DECODING_FAILED"
        } else if err.is_body() {
            "ERR_CONNECTION_CLOSED"
        } else {
            "ERR_FAILED"
        };
        Self::new(code, detail)
    }
}

impl fmt::Display for NetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.detail.is_empty() {
            write!(f, "net::{}", self.code)
        } else {
            write!(f, "net::{} ({})", self.code, self.detail)
        }
    }
}

impl StdError for NetError {}

fn tls_code(err: &rustls::Error) -> &'static str {
    use rustls::CertificateError as C;
    match err {
        rustls::Error::InvalidCertificate(cert) => match cert {
            C::UnknownIssuer | C::BadSignature => "ERR_CERT_AUTHORITY_INVALID",
            C::Expired | C::ExpiredContext { .. } | C::NotValidYet | C::NotValidYetContext { .. } => {
                "ERR_CERT_DATE_INVALID"
            }
            C::NotValidForName | C::NotValidForNameContext { .. } => "ERR_CERT_COMMON_NAME_INVALID",
            C::Revoked => "ERR_CERT_REVOKED",
            _ => "ERR_CERT_INVALID",
        },
        _ => "ERR_SSL_PROTOCOL_ERROR",
    }
}

/// `outer: inner: innermost`, skipping repeated messages.
fn error_chain(err: &dyn StdError) -> String {
    let mut out = err.to_string();
    let mut source = err.source();
    while let Some(e) = source {
        let msg = e.to_string();
        if !out.contains(&msg) {
            out.push_str(": ");
            out.push_str(&msg);
        }
        source = e.source();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn display() {
        assert_eq!(NetError::new("ERR_FAILED", "").to_string(), "net::ERR_FAILED");
        assert_eq!(
            NetError::invalid_url("x").to_string(),
            "net::ERR_INVALID_URL (x)"
        );
    }

    #[test]
    fn io_classification() {
        let e = io::Error::new(io::ErrorKind::NotFound, "gone");
        assert_eq!(NetError::from_io(&e, "/x").code(), "ERR_FILE_NOT_FOUND");
    }
}
