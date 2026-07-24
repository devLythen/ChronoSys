use thiserror::Error;

pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum FrameError {
    #[error("incomplete frame: need at least {need} bytes")]
    Incomplete { need: usize },
    #[error("frame too large: {len} bytes (max {max})", max = MAX_FRAME_BYTES)]
    TooLarge { len: usize },
}

/// Encode payload as u32 big-endian length + payload.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, FrameError> {
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge {
            len: payload.len(),
        });
    }
    let mut out = Vec::with_capacity(4 + payload.len());
    out.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    out.extend_from_slice(payload);
    Ok(out)
}

/// Decode one frame from `buf`.
/// Returns `(payload, bytes_consumed)`.
pub fn decode_frame(buf: &[u8]) -> Result<(Vec<u8>, usize), FrameError> {
    if buf.len() < 4 {
        return Err(FrameError::Incomplete { need: 4 });
    }
    let len = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if len > MAX_FRAME_BYTES {
        return Err(FrameError::TooLarge { len });
    }
    let total = 4 + len;
    if buf.len() < total {
        return Err(FrameError::Incomplete { need: total });
    }
    Ok((buf[4..total].to_vec(), total))
}
