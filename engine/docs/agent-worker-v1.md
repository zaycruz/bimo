# Agent worker v1

Rust is the factory authority. An adapter is a disposable model-loop process and communicates only through newline-delimited `agent-worker/v1` frames on stdin/stdout. Rust owns manifests, process groups, state generations, message and effect journals, capability authorization, terminal persistence, and operator output.

The first release permits only `pod.send_message` and `factory.read_state`. Caller identity comes from the live session; destinations and kinds must be declared by the manifest. Delivery is at-least-once with stable local message/effect identities. No exactly-once guarantee is made for external effects.

Worker commands are argv arrays, never shell strings. The executable must be absolute and trusted, the entrypoint must exist, environment names are allowlisted, and the private handoff is mode 0600. Pi-specific behavior lives only under `workers/pi-core`.

State uses `factory_state.json` schema version 2, append-only apply/delivery journals, immutable terminal/tool-result records, atomic rename publication, and an exclusive `locks/factory.lock`. Apply stages and handshakes replacements before publishing a generation and retiring old process groups.

The deterministic fixture worker is an explicit manifest command for provider-free acceptance; configured adapter failure never falls back to it.
