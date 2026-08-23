use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io;
pub const VERSION: &str = "agent-worker/v1";
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    WorkerToControl,
    ControlToWorker,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FrameType {
    Hello,
    HelloAck,
    WorkRequest,
    ToolCall,
    ToolResult,
    Cancel,
    CancelAck,
    Terminal,
    Heartbeat,
    Shutdown,
    ShutdownAck,
    ProtocolError,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frame {
    pub protocol: String,
    pub direction: Direction,
    #[serde(rename = "type")]
    pub kind: FrameType,
    pub factory_gen: u64,
    pub pod: String,
    pub session: String,
    pub seq: u64,
    #[serde(default)]
    pub request_id: Option<String>,
    #[serde(default)]
    pub tool_call_id: Option<String>,
    pub payload: Value,
}
pub fn parse(line: &[u8], max: usize) -> io::Result<Frame> {
    if line.len() > max {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "protocol frame exceeds limit",
        ));
    }
    let f: Frame =
        serde_json::from_slice(line).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    if f.protocol != VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "unsupported worker protocol",
        ));
    }
    validate_payload(&f)?;
    Ok(f)
}
fn validate_payload(frame: &Frame) -> io::Result<()> {
    let object = frame.payload.as_object().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            "frame payload must be an object",
        )
    })?;
    let require_string = |key: &str| {
        object
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("frame payload field {key} must be a non-empty string"),
                )
            })
    };
    match frame.kind {
        FrameType::Hello => {
            require_string("engine")?;
            require_string("launch_fingerprint")?;
        }
        FrameType::ToolCall => {
            require_string("name")?;
            if !object.get("arguments").is_some_and(Value::is_object) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "tool call arguments must be an object",
                ));
            }
        }
        FrameType::Terminal => {
            let status = require_string("status")?;
            match status {
                "success" => {
                    require_string("output")?;
                }
                "failed" => {
                    require_string("code")?;
                    require_string("message")?;
                }
                "cancelled" => {}
                _ => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "terminal status is not recognized",
                    ));
                }
            }
        }
        FrameType::CancelAck | FrameType::ShutdownAck => {
            require_string("status")?;
        }
        FrameType::ProtocolError => {
            require_string("status")?;
            require_string("error")?;
        }
        FrameType::ToolResult
        | FrameType::HelloAck
        | FrameType::WorkRequest
        | FrameType::Cancel
        | FrameType::Heartbeat
        | FrameType::Shutdown => {}
    }
    Ok(())
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ControlState {
    AwaitHello,
    Ready,
    Working,
    Cancelling,
    TerminalPersisted,
    Exiting,
    Stopped,
}
pub struct Machine {
    pub state: ControlState,
    pub worker_seq: u64,
    pub session: String,
}
impl Machine {
    pub fn accept(&mut self, f: &Frame) -> io::Result<()> {
        if f.session != self.session || f.seq != self.worker_seq + 1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "stale or out-of-order frame",
            ));
        }
        let next = match (self.state, f.kind.clone()) {
            (ControlState::AwaitHello, FrameType::Hello) => ControlState::Ready,
            (ControlState::Working, FrameType::Heartbeat | FrameType::ToolCall) => {
                ControlState::Working
            }
            (ControlState::Working, FrameType::Terminal) => ControlState::TerminalPersisted,
            (ControlState::Cancelling, FrameType::CancelAck) => ControlState::Exiting,
            (ControlState::Exiting, FrameType::ShutdownAck) => ControlState::Stopped,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "illegal protocol transition",
                ));
            }
        };
        self.worker_seq = f.seq;
        self.state = next;
        Ok(())
    }

    pub fn begin_work(&mut self) -> io::Result<()> {
        if self.state != ControlState::Ready {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "worker is not ready",
            ));
        }
        self.state = ControlState::Working;
        Ok(())
    }

    pub fn terminal_durable(&mut self) -> io::Result<()> {
        if self.state != ControlState::TerminalPersisted {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "terminal was not received",
            ));
        }
        self.state = ControlState::Ready;
        Ok(())
    }

    pub fn begin_cancel(&mut self) -> io::Result<()> {
        if self.state != ControlState::Working {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "worker has no active turn",
            ));
        }
        self.state = ControlState::Cancelling;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(kind: FrameType, seq: u64) -> Frame {
        Frame {
            protocol: VERSION.into(),
            direction: Direction::WorkerToControl,
            kind,
            factory_gen: 1,
            pod: "worker".into(),
            session: "session".into(),
            seq,
            request_id: None,
            tool_call_id: None,
            payload: serde_json::json!({}),
        }
    }

    #[test]
    fn machine_rejects_work_frames_before_handshake() {
        let mut machine = Machine {
            state: ControlState::AwaitHello,
            worker_seq: 0,
            session: "session".into(),
        };
        assert!(machine.accept(&frame(FrameType::Terminal, 1)).is_err());
        machine.accept(&frame(FrameType::Hello, 1)).unwrap();
        machine.begin_work().unwrap();
        machine.accept(&frame(FrameType::Terminal, 2)).unwrap();
        machine.terminal_durable().unwrap();
        assert_eq!(machine.state, ControlState::Ready);
    }
}
