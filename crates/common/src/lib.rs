//! Shared foundation for all processes: IPC transport, message protocol and
//! serializable display lists.

pub mod display_list;
pub mod ipc;
pub mod protocol;

/// Default User-Agent. Chrome-compatible token so sites serve modern markup.
pub const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
