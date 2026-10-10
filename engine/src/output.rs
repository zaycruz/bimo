//! The agent-native CLI contract (KTD6, U4).
//!
//! With `--output json`, every `bimo agent` command prints exactly one
//! JSON envelope on stdout, success or failure:
//!
//! ```json
//! {"schema":"bimo.cli/v1","command":"apply","ok":true,"changed":false,
//!  "result":{...},"error":null,"next":[],"idempotency_key":"..."}
//! ```
//!
//! `error.code` is stable; callers branch on it, never on `message`. `next`
//! lists concrete commands or fixes. The schema is `docs/agent-cli.schema.json`.
use crate::substrate::{codes, FabricError};
use serde::Serialize;

pub const SCHEMA: &str = "bimo.cli/v1";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Text,
    Json,
}

impl Format {
    pub fn parse(value: Option<&str>) -> Result<Self, FabricError> {
        match value {
            None | Some("text") => Ok(Self::Text),
            Some("json") => Ok(Self::Json),
            Some(other) => Err(FabricError::new(
                codes::USAGE,
                format!("unknown output format '{other}'"),
            )
            .next("use --output json or --output text")),
        }
    }
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub code: &'static str,
    pub message: String,
    pub details: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
pub struct Envelope {
    pub schema: &'static str,
    pub command: String,
    pub ok: bool,
    pub changed: bool,
    pub result: serde_json::Value,
    pub error: Option<ErrorBody>,
    pub next: Vec<String>,
    pub idempotency_key: Option<String>,
}

impl Envelope {
    pub fn success(
        command: &str,
        changed: bool,
        result: impl Serialize,
        next: Vec<String>,
        idempotency_key: Option<String>,
    ) -> Self {
        Self {
            schema: SCHEMA,
            command: command.to_owned(),
            ok: true,
            changed,
            result: serde_json::to_value(result).unwrap_or(serde_json::Value::Null),
            error: None,
            next,
            idempotency_key,
        }
    }

    pub fn failure(command: &str, error: FabricError) -> Self {
        Self {
            schema: SCHEMA,
            command: command.to_owned(),
            ok: false,
            changed: false,
            result: serde_json::Value::Null,
            next: error.next.clone(),
            error: Some(ErrorBody {
                code: error.code,
                message: error.message,
                details: error.details,
            }),
            idempotency_key: None,
        }
    }

    /// Print the envelope and return the process exit code: 0 on success,
    /// 2 for usage errors, 1 otherwise.
    pub fn emit(&self, format: Format) -> i32 {
        match format {
            Format::Json => {
                println!(
                    "{}",
                    serde_json::to_string(self).unwrap_or_else(|_| "{}".to_owned())
                );
            }
            Format::Text => self.print_text(),
        }
        match &self.error {
            None => 0,
            Some(error) if error.code == codes::USAGE => 2,
            Some(_) => 1,
        }
    }

    fn print_text(&self) {
        if let Some(error) = &self.error {
            eprintln!("error [{}]: {}", error.code, error.message);
            for detail in &error.details {
                if let (Some(field), Some(message)) =
                    (detail["field"].as_str(), detail["message"].as_str())
                {
                    eprintln!("  {field}: {message}");
                }
            }
            for hint in &self.next {
                eprintln!("next: {hint}");
            }
            return;
        }
        if self.command == "logs" {
            print!("{}", self.result["text"].as_str().unwrap_or_default());
            return;
        }
        println!(
            "{} {}",
            self.command,
            if self.changed { "changed" } else { "unchanged" }
        );
        println!(
            "{}",
            serde_json::to_string_pretty(&self.result).unwrap_or_default()
        );
        for hint in &self.next {
            println!("next: {hint}");
        }
    }
}
