//! Cross-language contract test: the shared protocol fixtures under
//! `protocol/fixtures/` must parse identically in Rust and in the Node
//! adapters. The Node side runs the same files in
//! `workers/pi-core/test/protocol.test.mjs`.
//!
//! Integration tests run with the package root as the working directory, so
//! the fixture paths are relative to the crate root.

use monolith::protocol::{self, ControlState, Direction, FrameType, Machine};

fn terminal_frame(payload: serde_json::Value) -> String {
    serde_json::json!({
        "protocol": protocol::VERSION,
        "direction": "worker_to_control",
        "type": "terminal",
        "factory_gen": 1,
        "pod": "worker",
        "session": "s1",
        "seq": 1,
        "payload": payload,
    })
    .to_string()
}

#[test]
fn failed_terminal_requires_safe_error_code() {
    // The canonical failure terminal carries a safe error code and message
    // (plan U3). It must parse.
    let ok = terminal_frame(serde_json::json!({
        "status": "failed",
        "code": "agent_error",
        "message": "agent execution failed",
    }));
    protocol::parse(ok.as_bytes(), 65_536)
        .unwrap_or_else(|e| panic!("failed terminal with code/message rejected: {e}"));

    // A failed terminal without the safe error code must fail closed.
    let missing_code = terminal_frame(serde_json::json!({
        "status": "failed",
        "message": "agent execution failed",
    }));
    let error = protocol::parse(missing_code.as_bytes(), 65_536)
        .expect_err("failed terminal without code must fail");
    assert!(error.to_string().contains("code"));

    // The legacy 'error' status is not part of the contract.
    let legacy = terminal_frame(serde_json::json!({
        "status": "error",
        "error": "boom",
    }));
    protocol::parse(legacy.as_bytes(), 65_536).expect_err("legacy error status must fail closed");
}

fn fixture_lines(name: &str) -> Vec<String> {
    let path = std::path::Path::new("protocol/fixtures").join(name);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("could not read fixture {name}: {e}"));
    text.lines()
        .map(str::to_owned)
        .filter(|line| !line.trim().is_empty())
        .collect()
}

#[test]
fn legal_handshake_fixture_parses_on_both_directions() {
    let lines = fixture_lines("legal-handshake.jsonl");
    assert_eq!(lines.len(), 2);
    for line in &lines {
        let frame = protocol::parse(line.as_bytes(), 65_536)
            .unwrap_or_else(|e| panic!("legal fixture line rejected: {e}"));
        assert_eq!(frame.protocol, protocol::VERSION);
    }
    // The first line is the worker hello; the second is the control hello_ack.
    let hello = protocol::parse(lines[0].as_bytes(), 65_536).unwrap();
    assert_eq!(hello.kind, FrameType::Hello);
    assert_eq!(hello.direction, Direction::WorkerToControl);
    let ack = protocol::parse(lines[1].as_bytes(), 65_536).unwrap();
    assert_eq!(ack.kind, FrameType::HelloAck);
    assert_eq!(ack.direction, Direction::ControlToWorker);
}

#[test]
fn legal_handshake_fixture_drives_the_state_machine() {
    let lines = fixture_lines("legal-handshake.jsonl");
    let hello = protocol::parse(lines[0].as_bytes(), 65_536).unwrap();
    let mut machine = Machine {
        state: ControlState::AwaitHello,
        worker_seq: 0,
        session: hello.session.clone(),
    };
    machine
        .accept(&hello)
        .expect("hello must advance the machine");
    assert_eq!(machine.state, ControlState::Ready);
}

#[test]
fn illegal_sequence_fixture_fails_closed() {
    let lines = fixture_lines("illegal-sequence.jsonl");
    assert_eq!(lines.len(), 1);
    // The fixture is a hello with a stale session, out-of-order sequence, and
    // an empty payload. It must fail at parse time (missing engine and
    // launch_fingerprint) and never reach the state machine.
    let error =
        protocol::parse(lines[0].as_bytes(), 65_536).expect_err("illegal fixture must fail");
    assert!(error.to_string().contains("engine"));
}
