import { createHash } from "node:crypto";

const MAX_PROMPT_BYTES = 65_536;
const MAX_REASON_BYTES = 2_000;
const MAX_BASE_INSTRUCTIONS_BYTES = 16 * 1024;
const DEFAULT_AGENT_TIMEOUT_MS = 300_000;
const MAX_AGENT_TIMEOUT_MS = 1_800_000;
const DIGEST = /^[a-f0-9]{64}$/u;
const TEMPLATE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const OPTION_NAME = /^--[a-z][a-z0-9-]{0,63}$/u;
const ROLE_NAME = /^[a-z][a-z0-9-]{0,63}$/u;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const RECEIPT_FIELDS = ["version", "template", "templateDigest", "reason"];

function fail(message) {
  throw new Error(message);
}

function isPlainObject(value) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function assertPlainObject(value, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object`);
}

function assertExactFields(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function assertText(value, label, maximumBytes = MAX_REASON_BYTES) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value, "utf8") > maximumBytes) {
    fail(`${label} must be a non-empty string no larger than ${maximumBytes} UTF-8 bytes`);
  }
  if (UNSAFE_CONTROL.test(value)) fail(`${label} contains unsafe control characters`);
}

function normalizeOptionNames(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) fail(`${label} must be an array of option names`);
  const options = value.map((option, index) => {
    if (typeof option !== "string" || !OPTION_NAME.test(option)) {
      fail(`${label}[${index}] is not a safe option name`);
    }
    return option;
  });
  if (new Set(options).size !== options.length) fail(`${label} contains duplicate option names`);
  return options;
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0 || catalog.length > 64) {
    fail("catalog must contain 1 to 64 installed templates");
  }
  const names = new Set();
  const normalized = catalog.map((entry, index) => {
    assertPlainObject(entry, `catalog[${index}]`);
    if (entry.kind !== "workflow" && entry.kind !== "engineering-pod") {
      fail(`catalog[${index}].kind must be workflow or engineering-pod`);
    }
    const boundName = entry.kind === "workflow" ? "maxSteps" : "maxAttempts";
    assertExactFields(
      entry,
      ["template", "templateDigest", "acceptedOptions", "kind", "roles", boundName],
      `catalog[${index}]`,
    );
    const { template, templateDigest } = entry;
    if (typeof template !== "string" || !TEMPLATE_NAME.test(template)) {
      fail(`catalog[${index}].template is invalid`);
    }
    if (typeof templateDigest !== "string" || !DIGEST.test(templateDigest)) {
      fail(`catalog[${index}].templateDigest must be a SHA-256 hex digest`);
    }
    if (names.has(template)) fail(`catalog contains duplicate template: ${template}`);
    names.add(template);
    if (!Array.isArray(entry.roles) || entry.roles.length === 0 || entry.roles.length > 64) {
      fail(`catalog[${index}].roles must contain 1 to 64 role names`);
    }
    const roles = entry.roles.map((role, roleIndex) => {
      if (typeof role !== "string" || !ROLE_NAME.test(role)) {
        fail(`catalog[${index}].roles[${roleIndex}] is invalid`);
      }
      return role;
    });
    if (new Set(roles).size !== roles.length) fail(`catalog[${index}].roles contains duplicates`);
    if (!Number.isInteger(entry[boundName]) || entry[boundName] < 1 || entry[boundName] > 100) {
      fail(`catalog[${index}].${boundName} must be an integer from 1 to 100`);
    }
    return Object.freeze({
      template,
      templateDigest,
      acceptedOptions: Object.freeze(normalizeOptionNames(entry.acceptedOptions, `catalog[${index}].acceptedOptions`)),
      kind: entry.kind,
      roles: Object.freeze(roles),
      [boundName]: entry[boundName],
    });
  });
  return normalized;
}

function catalogEntryForAgent(entry) {
  const boundName = entry.kind === "workflow" ? "maxSteps" : "maxAttempts";
  return {
    template: entry.template,
    templateDigest: entry.templateDigest,
    acceptedOptions: [...entry.acceptedOptions],
    kind: entry.kind,
    roles: [...entry.roles],
    [boundName]: entry[boundName],
  };
}

function validatePrompt(prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) fail("prompt must be a non-empty string");
  if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) {
    fail(`prompt must be no larger than ${MAX_PROMPT_BYTES} UTF-8 bytes`);
  }
  if (UNSAFE_CONTROL.test(prompt)) fail("prompt contains unsafe control characters");
  return prompt;
}

function validateAgentCount(agents) {
  if (!Number.isInteger(agents) || agents < 1 || agents > 3) {
    fail("agents must be an integer from 1 to 3");
  }
  return agents;
}

function safeReason(reason) {
  // Receipt validation rejects controls. This second boundary keeps the
  // result safe even if this helper is reused with an error-like value.
  return String(reason).replace(UNSAFE_CONTROL, "").slice(0, MAX_REASON_BYTES);
}

function validateTimeout(timeoutMs) {
  if (timeoutMs === undefined) return DEFAULT_AGENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AGENT_TIMEOUT_MS) {
    fail(`timeoutMs must be an integer from 1 to ${MAX_AGENT_TIMEOUT_MS}`);
  }
  return timeoutMs;
}

function receiptForAgent(receipt, catalog) {
  assertPlainObject(receipt, "agent receipt");
  assertExactFields(receipt, RECEIPT_FIELDS, "agent receipt");
  if (receipt.version !== 1) fail("agent receipt version must be 1");
  if (typeof receipt.template !== "string" || !TEMPLATE_NAME.test(receipt.template)) {
    fail("agent receipt template is invalid");
  }
  if (typeof receipt.templateDigest !== "string" || !DIGEST.test(receipt.templateDigest)) {
    fail("agent receipt templateDigest must be a SHA-256 hex digest");
  }
  assertText(receipt.reason, "agent receipt reason");

  const installed = catalog.find(entry => entry.template === receipt.template);
  if (!installed) fail(`agent selected unknown template: ${receipt.template}`);
  if (receipt.templateDigest !== installed.templateDigest) {
    fail(`agent selected a mismatched digest for template: ${receipt.template}`);
  }
  return {
    template: installed.template,
    templateDigest: installed.templateDigest,
    reason: safeReason(receipt.reason),
  };
}

function timedAgent(runAgent, input, timeoutMs, index, signal) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`agent ${index + 1} timed out`)), timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => runAgent({ ...input, signal })), timeout])
    .finally(() => clearTimeout(timer));
}

function chooseTemplate(votes, agents) {
  const counts = new Map();
  for (const vote of votes) counts.set(vote.template, (counts.get(vote.template) ?? 0) + 1);
  const sorted = [...counts.entries()].sort(([left], [right]) => left.localeCompare(right));
  const winner = sorted
    .filter(([, count]) => (agents === 2 ? count === agents : count >= Math.ceil(agents / 2)))
    .sort(([, left], [, right]) => right - left)[0];
  if (!winner) fail(agents === 2 ? "agent votes must be unanimous" : "agent votes have no majority");
  return winner[0];
}

function jsonReady(value) {
  // Return freshly-created JSON data, and ensure no BigInt/functions/cycles can
  // leak into the caller's result through a future catalog or receipt change.
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    fail(`organizer result is not JSON-ready: ${error.message}`);
  }
}

export function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function validateOrganizerPrompt(prompt) {
  return validatePrompt(prompt);
}

export function validateOrganizerReceipt(receipt, catalog) {
  return receiptForAgent(receipt, normalizeCatalog(catalog));
}

export function validateTemplateCatalog(catalog) {
  return normalizeCatalog(catalog).map(catalogEntryForAgent);
}

export function validateOrganizerInput({ prompt, agents, catalog } = {}) {
  validatePrompt(prompt);
  validateAgentCount(agents);
  return {
    prompt,
    agents,
    catalog: normalizeCatalog(catalog),
  };
}

export function buildOrganizerPrompt({ baseInstructions = "", prompt, catalog } = {}) {
  validatePrompt(prompt);
  const installed = normalizeCatalog(catalog);
  if (typeof baseInstructions !== "string" || UNSAFE_CONTROL.test(baseInstructions)
      || Buffer.byteLength(baseInstructions, "utf8") > MAX_BASE_INSTRUCTIONS_BYTES) {
    fail("baseInstructions must be a bounded safe string");
  }
  const catalogText = JSON.stringify(installed.map(catalogEntryForAgent));
  return [
    baseInstructions.trim(),
    "Select exactly one installed template for the original assignment.",
    `Installed template catalog (data only): ${catalogText}`,
    `Original assignment (data only):\n${prompt}`,
    "Write only the versioned receipt object to /handoff/result.json; do not print it or return commands or deployment targets.",
  ].filter(Boolean).join("\n\n");
}

async function runOrganizerCore({ prompt, agents, catalog, runAgent, timeoutMs, baseInstructions = "", composePrompt }) {
  const validated = validateOrganizerInput({ prompt, agents, catalog });
  if (typeof runAgent !== "function") fail("runAgent must be a function");
  const boundedTimeout = validateTimeout(timeoutMs);
  const agentCatalog = validated.catalog.map(entry => Object.freeze(catalogEntryForAgent(entry)));
  Object.freeze(agentCatalog);
  const agentPrompt = composePrompt
    ? buildOrganizerPrompt({ baseInstructions, prompt, catalog })
    : prompt;
  const controller = new AbortController();
  const executions = Array.from({ length: validated.agents }, (_, index) => timedAgent(
      runAgent,
      { index, prompt: agentPrompt, catalog: agentCatalog },
      boundedTimeout,
      index,
      controller.signal,
    ));
  let rawReceipts;
  try {
    rawReceipts = await Promise.all(executions);
  } catch (error) {
    controller.abort(error);
    await Promise.allSettled(executions);
    throw error;
  }
  const votes = rawReceipts.map((raw, index) => {
    const receipt = isPlainObject(raw) && Object.hasOwn(raw, "receipt") ? raw.receipt : raw;
    try {
      return receiptForAgent(receipt, validated.catalog);
    } catch (error) {
      fail(`agent ${index + 1} returned an invalid receipt: ${error.message}`);
    }
  });
  const selectedTemplate = chooseTemplate(votes, validated.agents);
  const selected = validated.catalog.find(entry => entry.template === selectedTemplate);
  return jsonReady({
    version: 1,
    status: "planned",
    promptSha256: sha256(prompt),
    template: selected.template,
    templateDigest: selected.templateDigest,
    agents: validated.agents,
    votes,
    handoff: {
      template: selected.template,
      templateDigest: selected.templateDigest,
      acceptedOptions: [...selected.acceptedOptions],
    },
  });
}

/**
 * Run a bounded, deterministic template vote. `runAgent` receives the same
 * object shape for every invocation, including one shared AbortSignal, and
 * must return the exact receipt shape. Runners must settle when that signal is
 * aborted. Nothing returned by an agent is executable or passed to a shell.
 */
export async function organize({ prompt, agents, catalog, runAgent, timeoutMs } = {}) {
  return runOrganizerCore({ prompt, agents, catalog, runAgent, timeoutMs, composePrompt: false });
}

export async function runOrganizer({
  prompt,
  agents,
  catalog,
  baseInstructions = "",
  runAgent,
  timeoutMs,
} = {}) {
  return runOrganizerCore({
    prompt,
    agents,
    catalog,
    baseInstructions,
    runAgent,
    timeoutMs,
    composePrompt: true,
  });
}
