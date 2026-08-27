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
});

export const AGENT_RUNTIME_NAMES = Object.freeze(Object.keys(AGENT_RUNTIMES));

export function agentRuntimeFor(name) {
  if (!AGENT_RUNTIME_NAME.test(name ?? "") || !Object.hasOwn(AGENT_RUNTIMES, name)) {
    fail(`unknown agent runtime: ${name ?? ""}`);
  }
  return AGENT_RUNTIMES[name];
}
