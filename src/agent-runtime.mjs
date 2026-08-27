import process from "node:process";

const AGENT_RUNTIME_NAME = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_DIAGNOSTIC_LINE_BYTES = 65_536;
const DIAGNOSTIC_EVENT_TYPES = new Set([
  "error",
  "reasoning",
  "step_finish",
  "step_start",
  "text",
  "tool_use",
]);
const PI_DIAGNOSTIC_EVENT_TYPES = new Set([
  "agent_end",
  "agent_settled",
  "agent_start",
  "auto_retry_end",
  "auto_retry_start",
  "error",
  "message_end",
  "message_start",
  "message_update",
  "session",
  "tool_execution_end",
  "tool_execution_start",
  "tool_execution_update",
  "turn_end",
  "turn_start",
]);

export const AGENT_INSTRUCTIONS_PATH = "/instructions/instructions.md";
export const DEFAULT_AGENT_RUNTIME = "opencode";

function fail(message) {
  throw new Error(message);
}

function findHttpStatus(value, depth = 0, budget = { visited: 0 }) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || depth > 4 || budget.visited >= 32) return null;
  budget.visited += 1;
  for (const key of ["status", "statusCode"]) {
    const raw = value[key];
    const status = typeof raw === "string" && /^\d{3}$/u.test(raw) ? Number(raw) : raw;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return status;
  }
  for (const nested of Object.values(value)) {
    const status = findHttpStatus(nested, depth + 1, budget);
    if (status !== null) return status;
  }
  return null;
}

export function createOpenCodeDiagnostics() {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutLine = "";
  let discardingLine = false;
  let finished = false;
  const decoder = new TextDecoder("utf-8");
  const eventCounts = new Map();
  let errorStatus = null;
  const recordEvent = line => {
    if (!line || Buffer.byteLength(line) > MAX_DIAGNOSTIC_LINE_BYTES) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)
        || !DIAGNOSTIC_EVENT_TYPES.has(event.type)) return;
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    if (event.type === "error") errorStatus = findHttpStatus(event.error);
  };
  return {
    stdout(chunk) {
      stdoutBytes += chunk.length;
      let text = decoder.decode(chunk, { stream: true });
      if (discardingLine) {
        const newline = text.indexOf("\n");
        if (newline === -1) return;
        discardingLine = false;
        text = text.slice(newline + 1);
      }
      const lines = `${stdoutLine}${text}`.split("\n");
      stdoutLine = lines.pop() ?? "";
      for (const line of lines) recordEvent(line);
      if (Buffer.byteLength(stdoutLine) > MAX_DIAGNOSTIC_LINE_BYTES) {
        stdoutLine = "";
        discardingLine = true;
      }
    },
    stderr(chunk) {
      stderrBytes += chunk.length;
    },
    failure(code) {
      if (finished) throw new Error("OpenCode diagnostics already finalized");
      finished = true;
      const finalLine = discardingLine ? "" : `${stdoutLine}${decoder.decode()}`;
      if (finalLine) recordEvent(finalLine);
      const exit = Number.isInteger(code) ? `agent exited ${code}` : "agent exited on signal";
      const events = [...eventCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, count]) => `${type}:${count}`)
        .join(",");
      return [
        exit,
        ...(events ? [`events=${events}`] : []),
        ...(errorStatus === null ? [] : [`errorStatus=${errorStatus}`]),
        `stdoutBytes=${stdoutBytes}`,
        `stderrBytes=${stderrBytes}`,
      ].join("; ");
    },
  };
}

// pi can exit 0 on a provider failure: the error surfaces as a turn_end
// event whose message.stopReason is "error" and whose message.errorMessage
// carries the HTTP status as a leading "NNN:" prefix. failure() is only
// reached on a non-zero exit; for the exit-0 case the dispatcher's handoff
// check backstops the failure (no /handoff/result.json fails the role).
export function createPiDiagnostics() {
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutLine = "";
  let discardingLine = false;
  let finished = false;
  const decoder = new TextDecoder("utf-8");
  const eventCounts = new Map();
  let errorStatus = null;
  const recordEvent = line => {
    if (!line || Buffer.byteLength(line) > MAX_DIAGNOSTIC_LINE_BYTES) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)
        || !PI_DIAGNOSTIC_EVENT_TYPES.has(event.type)) return;
    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
    const message = event.message;
    if (message && typeof message === "object" && !Array.isArray(message)
        && message.stopReason === "error" && typeof message.errorMessage === "string") {
      const match = /^(\d{3})\b/u.exec(message.errorMessage);
      if (match) errorStatus = Number(match[1]);
    }
  };
  return {
    stdout(chunk) {
      stdoutBytes += chunk.length;
      let text = decoder.decode(chunk, { stream: true });
      if (discardingLine) {
        const newline = text.indexOf("\n");
        if (newline === -1) return;
        discardingLine = false;
        text = text.slice(newline + 1);
      }
      const lines = `${stdoutLine}${text}`.split("\n");
      stdoutLine = lines.pop() ?? "";
      for (const line of lines) recordEvent(line);
      if (Buffer.byteLength(stdoutLine) > MAX_DIAGNOSTIC_LINE_BYTES) {
        stdoutLine = "";
        discardingLine = true;
      }
    },
    stderr(chunk) {
      stderrBytes += chunk.length;
    },
    failure(code) {
      if (finished) throw new Error("pi diagnostics already finalized");
      finished = true;
      const finalLine = discardingLine ? "" : `${stdoutLine}${decoder.decode()}`;
      if (finalLine) recordEvent(finalLine);
      const exit = Number.isInteger(code) ? `agent exited ${code}` : "agent exited on signal";
      const events = [...eventCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([type, count]) => `${type}:${count}`)
        .join(",");
      return [
        exit,
        ...(events ? [`events=${events}`] : []),
        ...(errorStatus === null ? [] : [`errorStatus=${errorStatus}`]),
        `stdoutBytes=${stdoutBytes}`,
        `stderrBytes=${stderrBytes}`,
      ].join("; ");
    },
  };
}

const AGENT_RUNTIMES = Object.freeze({
  opencode: Object.freeze({
    name: "opencode",
    spawnArgv({ model, role }) {
      return [
        "opencode",
        "run",
        "--pure",
        "--auto",
        "--agent", "build",
        "--format", "json",
        "--dir", "/workspace",
        "--model", model,
        "--file", AGENT_INSTRUCTIONS_PATH,
        "--title", `bimo-${role}`,
        "Follow the attached Bimo instructions exactly.",
      ];
    },
    spawnEnv({ gateway }) {
      return {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/node",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "1",
        BIMO_GATEWAY_URL: gateway,
        OPENCODE_CONFIG: "/etc/opencode/opencode.json",
      };
    },
    createDiagnostics: createOpenCodeDiagnostics,
  }),
  pi: Object.freeze({
    name: "pi",
    spawnArgv({ model }) {
      return [
        "pi",
        "-p",
        "--mode", "json",
        "--no-session",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-themes",
        "--no-context-files",
        "--tools", "read,write,edit,bash,grep,find,ls",
        // Bimo model ids are openrouter/<rest>; pi resolves the provider on
        // the first slash and the shipped provider is named bimo-gateway.
        "--model", model.replace(/^openrouter\//u, "bimo-gateway/"),
        // pi has no --file flag; instructions attach as an @file message.
        `@${AGENT_INSTRUCTIONS_PATH}`,
        "Follow the attached Bimo instructions exactly.",
      ];
    },
    spawnEnv({ gateway }) {
      return {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/home/node",
        TMPDIR: "/tmp",
        LANG: "C.UTF-8",
        CI: "1",
        PI_OFFLINE: "1",
        // pi writes a settings lock and an auth store next to its config,
        // and the container root filesystem is read-only: the dispatcher
        // seeds the baked /etc/pi/agent config into the writable HOME
        // tmpfs (seedConfig below) and pi uses the writable copy.
        PI_CODING_AGENT_DIR: "/home/node/.pi/agent",
        BIMO_GATEWAY_URL: gateway,
      };
    },
    seedConfig: Object.freeze({
      source: "/etc/pi/agent",
      target: "/home/node/.pi/agent",
    }),
    createDiagnostics: createPiDiagnostics,
  }),
});

export const AGENT_RUNTIME_NAMES = Object.freeze(Object.keys(AGENT_RUNTIMES));

export function agentRuntimeFor(name) {
  if (!AGENT_RUNTIME_NAME.test(name ?? "") || !Object.hasOwn(AGENT_RUNTIMES, name)) {
    fail(`unknown agent runtime: ${name ?? ""}`);
  }
  return AGENT_RUNTIMES[name];
}
