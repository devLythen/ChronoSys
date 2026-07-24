use chrono_ipc::{
    decode_frame, encode_frame, ChronoEvent, FrameError, ToolIpcMessage, MAX_FRAME_BYTES,
};
use serde_json::Value;

#[test]
fn frame_roundtrip_empty() {
    let payload = b"";
    let framed = encode_frame(payload).unwrap();
    let (decoded, consumed) = decode_frame(&framed).unwrap();
    assert_eq!(decoded, payload);
    assert_eq!(consumed, 4);
}

#[test]
fn frame_roundtrip_one_byte() {
    let payload = b"x";
    let framed = encode_frame(payload).unwrap();
    let (decoded, consumed) = decode_frame(&framed).unwrap();
    assert_eq!(decoded, payload);
    assert_eq!(consumed, 5);
}

#[test]
fn frame_roundtrip_1000_bytes() {
    let payload = vec![0xABu8; 1000];
    let framed = encode_frame(&payload).unwrap();
    let (decoded, consumed) = decode_frame(&framed).unwrap();
    assert_eq!(decoded, payload);
    assert_eq!(consumed, 1004);
}

#[test]
fn frame_truncated_header() {
    let err = decode_frame(&[0x00, 0x00]).unwrap_err();
    assert_eq!(err, FrameError::Incomplete { need: 4 });
}

#[test]
fn frame_truncated_body() {
    let err = decode_frame(&[0x00, 0x00, 0x00, 0x05, 0x01, 0x02]).unwrap_err();
    assert_eq!(err, FrameError::Incomplete { need: 9 });
}

#[test]
fn frame_too_large() {
    let len = (MAX_FRAME_BYTES as u32).wrapping_add(1);
    let mut buf = len.to_be_bytes().to_vec();
    buf.extend_from_slice(&[0u8; 8]);
    let err = decode_frame(&buf).unwrap_err();
    assert_eq!(
        err,
        FrameError::TooLarge {
            len: MAX_FRAME_BYTES + 1
        }
    );
}

fn fixture_path(name: &str) -> String {
    format!(
        "{}/../../schemas/fixtures/{}",
        env!("CARGO_MANIFEST_DIR"),
        name
    )
}

fn assert_fixture_roundtrip<T>(name: &str)
where
    T: serde::Serialize + serde::de::DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let path = fixture_path(name);
    let raw = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("read {path}: {e}"));
    let original: Value = serde_json::from_str(&raw).unwrap();
    let typed: T = serde_json::from_str(&raw).unwrap_or_else(|e| panic!("deserialize {name}: {e}"));
    let reencoded = serde_json::to_value(&typed).unwrap();
    assert_eq!(
        reencoded, original,
        "fixture {name} did not roundtrip identically"
    );
}

#[test]
fn fixture_inbound_message() {
    assert_fixture_roundtrip::<ChronoEvent>("inbound_message.json");
}

#[test]
fn fixture_tool_request() {
    assert_fixture_roundtrip::<ToolIpcMessage>("tool_request.json");
}

#[test]
fn fixture_tool_response_ok() {
    assert_fixture_roundtrip::<ToolIpcMessage>("tool_response_ok.json");
}

#[test]
fn fixture_tool_response_err() {
    assert_fixture_roundtrip::<ToolIpcMessage>("tool_response_err.json");
}
