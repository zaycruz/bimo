import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const TEMPLATE_FIELDS = [
  "version",
  "name",
  "maxAttempts",
  "timeouts",
  "changes",
  "writers",
  "prompts",
  "verificationProfile",
];
const WRITER_IDS = ["engineering-a", "engineering-b", "qa-tests"];
const WRITER_FIELDS = ["prompt", "allowedWriteRoots"];
const PROMPT_IDS = ["planner", "checker", "qa", "testing"];
const TIMEOUT_FIELDS = ["executionSeconds", "attemptSeconds", "workflowSeconds"];
const CHANGE_FIELDS = ["maxFiles", "maxBytes"];
const PLAN_FIELDS = ["version", "attempt", "baseSha", "requirements", "acceptanceCriteria", "writers"];
const REQUIREMENT_FIELDS = ["id", "text"];
const ACCEPTANCE_FIELDS = ["id", "requirementIds", "text"];
const PLAN_WRITER_FIELDS = ["brief", "requirementIds", "acceptanceIds", "writePaths"];
const WRITER_RECEIPT_FIELDS = [
  "outcome",
  "baseSha",
  "what",
  "why",
  "evidence",
  "requirementIds",
  "acceptanceIds",
  "inboxCursor",
  "dependencyRequest",
];
const DEPENDENCY_REQUEST_FIELDS = [
  "owner",
  "path",
  "requirementIds",
  "acceptanceIds",
  "ownerBriefSha256",
  "need",
  "why",
];
const INBOX_ENTRY_FIELDS = [
  "sequence",
  "requester",
  "owner",
  "path",
  "requirementIds",
  "acceptanceIds",
  "ownerBriefSha256",
  "need",
  "why",
  "requesterCheckpointSha",
];
const CHECKER_RECEIPT_FIELDS = [
  "outcome",
  "baseSha",
  "resultSha",
  "diffSha256",
  "what",
  "why",
  "evidence",
  "requirementIds",
  "acceptanceIds",
  "files",
  "deliveredInbox",
];
const CONFORMANCE_RECEIPT_FIELDS = [
  "gate",
  "outcome",
  "candidateSha",
  "what",
  "why",
  "evidence",
  "requirementIds",
  "acceptanceIds",
  "files",
];
const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const VERIFICATION_PROFILES = new Set(["monolith-repo-v1"]);
const TRACE_ID = /^[A-Z][A-Z0-9-]{0,63}$/;
const GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const PORTABLE_COMPONENT = /^[A-Za-z0-9._-]+$/;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const MAX_RECEIPT_BYTES = 60 * 1024;

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

function assertExactFields(value, allowed, label) {
  for (const field of Object.keys(value)) {
    if (!allowed.includes(field)) fail(`unknown ${label} field: ${field}`);
  }
  for (const field of allowed) {
    if (!Object.hasOwn(value, field)) fail(`${label} requires ${field}`);
  }
}

function assertInteger(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    fail(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function assertText(value, label, maximum = 2_000) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maximum) {
    fail(`${label} must be a non-empty string no larger than ${maximum} bytes`);
  }
  if (UNSAFE_CONTROL.test(value)) fail(`${label} contains unsafe control characters`);
}

function assertPromptPath(value, label) {
  assertText(value, label, 512);
  if (value.includes("\\") || path.posix.isAbsolute(value)) {
    fail(`${label} must be a canonical relative path`);
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")
      || path.posix.normalize(value) !== value) {
    fail(`${label} must be a canonical relative path`);
  }
}

function assertRepositoryDirectory(value, label) {
  assertText(value, label, 512);
  if (value.includes("\\") || path.posix.isAbsolute(value)) {
    fail(`${label} must be a canonical relative directory`);
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")
      || path.posix.normalize(value) !== value) {
    fail(`${label} must be a canonical relative directory`);
  }
  if (Buffer.byteLength(value) > 240 || segments.some(segment => !PORTABLE_COMPONENT.test(segment))) {
    fail(`${label} must be a portable ASCII path no larger than 240 bytes`);
  }
  const folded = segments.map(segment => segment.toLowerCase());
  if (folded.includes(".git") || folded.includes(".github")) {
    fail(`${label} names a forbidden repository control path`);
  }
}

export function assertRepositoryFile(value, label) {
  assertText(value, label, 512);
  if (value.includes("\\") || path.posix.isAbsolute(value) || value.endsWith("/")) {
    fail(`${label} must be a canonical relative file path`);
  }
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === "..")
      || path.posix.normalize(value) !== value) {
    fail(`${label} must be a canonical relative file path`);
  }
  if (Buffer.byteLength(value) > 240 || segments.some(segment => !PORTABLE_COMPONENT.test(segment))) {
    fail(`${label} must be a portable ASCII path no larger than 240 bytes`);
  }
  const folded = segments.map(segment => segment.toLowerCase());
  if (folded.includes(".git") || folded.includes(".github")) {
    fail(`${label} names a forbidden repository control path`);
  }
}

function directoryContains(parent, child) {
  return parent === child || child.startsWith(`${parent}/`);
}

function directoriesOverlap(left, right) {
  const foldedLeft = left.toLowerCase();
  const foldedRight = right.toLowerCase();
  return foldedLeft === foldedRight
    || foldedLeft.startsWith(`${foldedRight}/`)
    || foldedRight.startsWith(`${foldedLeft}/`);
}

function descendant(root, target) {
  return target === root || target.startsWith(`${root}${path.sep}`);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map(key => (
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    )).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertFixedKeys(value, expected, label) {
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function assertTraceId(value, label) {
  if (typeof value !== "string" || !TRACE_ID.test(value)) {
    fail(`${label} must be a stable uppercase ID`);
  }
}

function assertGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    fail(`${label} must be a lowercase 40- or 64-character Git SHA`);
  }
}

function validateIdArray(values, known, label, { maximum = 100 } = {}) {
  if (!Array.isArray(values) || values.length < 1 || values.length > maximum) {
    fail(`${label} must contain 1 to ${maximum} stable IDs`);
  }
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertTraceId(value, `${label}[${index}]`);
    if (seen.has(value)) fail(`${label} contains duplicate ID: ${value}`);
    if (known && !known.has(value)) fail(`${label} references unknown ID: ${value}`);
    seen.add(value);
  }
  return seen;
}

function assertExactStringArray(actual, expected, label) {
  if (!Array.isArray(actual)
      || actual.length !== expected.length
      || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} must exactly match the attempt plan`);
  }
}

function validateEvidence(values, label) {
  if (!Array.isArray(values) || !values.length || values.length > 20) {
    fail(`${label} must contain 1 to 20 strings`);
  }
  for (let index = 0; index < values.length; index += 1) {
    assertText(values[index], `${label}[${index}]`, 2_000);
  }
}

function assertIdsCovered(values, requesterValues, ownerValues, label) {
  const requester = new Set(requesterValues);
  const owner = new Set(ownerValues);
  if (!Array.isArray(values) || !values.length) fail(`${label} must be a non-empty array`);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertTraceId(value, `${label}[${index}]`);
    if (seen.has(value)) fail(`${label} contains duplicate ID: ${value}`);
    if (!requester.has(value) || !owner.has(value)) {
      fail(`${label} must be covered by both writer items: ${value}`);
    }
    seen.add(value);
  }
}

function validateDependencyRequest(request, { plan, writerId }) {
  if (!writerId.startsWith("engineering-")) {
    fail("only Engineering writers may return a same-owner dependency request");
  }
  assertPlainObject(request, "dependency request");
  assertExactFields(request, DEPENDENCY_REQUEST_FIELDS, "dependency request");
  const expectedOwner = writerId === "engineering-a" ? "engineering-b" : "engineering-a";
  if (request.owner !== expectedOwner) {
    fail("dependency owner must be the other Engineering slot");
  }
  const requester = plan.writers[writerId];
  const owner = plan.writers[request.owner];
  assertRepositoryFile(request.path, "dependency path");
  if (!owner.writePaths.some(writePath => directoryContains(writePath, request.path))) {
    fail(`dependency path must be inside ${request.owner} writePaths`);
  }
  assertIdsCovered(
    request.requirementIds,
    requester.requirementIds,
    owner.requirementIds,
    "dependency requirementIds",
  );
  assertIdsCovered(
    request.acceptanceIds,
    requester.acceptanceIds,
    owner.acceptanceIds,
    "dependency acceptanceIds",
  );
  const requestedRequirements = new Set(request.requirementIds);
  for (const acceptanceId of request.acceptanceIds) {
    const criterion = plan.acceptanceCriteria.find(item => item.id === acceptanceId);
    for (const requirementId of criterion.requirementIds) {
      if (!requestedRequirements.has(requirementId)) {
        fail(`dependency acceptance ${acceptanceId} requires ${requirementId}`);
      }
    }
  }
  if (typeof request.ownerBriefSha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(request.ownerBriefSha256)
      || request.ownerBriefSha256 !== sha256(owner.brief)) {
    fail("dependency owner brief does not match the immutable attempt plan");
  }
  assertText(request.need, "dependency need");
  assertText(request.why, "dependency why");
}

function validateDeliveredInbox(entries, { plan, owner, previousInboxCursor }) {
  if (!Array.isArray(entries) || entries.length > 20) {
    fail("deliveredInbox must be an array of at most 20 entries");
  }
  let cursor = previousInboxCursor;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    assertPlainObject(entry, `deliveredInbox[${index}]`);
    assertExactFields(entry, INBOX_ENTRY_FIELDS, `deliveredInbox[${index}]`);
    assertInteger(entry.sequence, cursor + 1, cursor + 1, `deliveredInbox[${index}].sequence`);
    if (entry.owner !== owner) fail(`deliveredInbox[${index}] owner must be ${owner}`);
    const request = {
      owner: entry.owner,
      path: entry.path,
      requirementIds: entry.requirementIds,
      acceptanceIds: entry.acceptanceIds,
      ownerBriefSha256: entry.ownerBriefSha256,
      need: entry.need,
      why: entry.why,
    };
    validateDependencyRequest(request, { plan, writerId: entry.requester });
    assertGitSha(entry.requesterCheckpointSha, `deliveredInbox[${index}].requesterCheckpointSha`);
    cursor = entry.sequence;
  }
  return cursor;
}

function validateExistingDirectories(values) {
  if (!Array.isArray(values) || !values.length || values.length > 100_000) {
    fail("existingDirectories must be a non-empty array");
  }
  const exact = new Set();
  const folded = new Map();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    assertText(value, `existingDirectories[${index}]`, 512);
    if (value.includes("\\") || path.posix.isAbsolute(value)
        || value.split("/").some(segment => !segment || segment === "." || segment === "..")
        || path.posix.normalize(value) !== value) {
      fail(`existingDirectories[${index}] must be a canonical relative directory`);
    }
    const lower = value.toLowerCase();
    const collision = folded.get(lower);
    if (collision && collision !== value) {
      fail(`repository contains a case-colliding directory: ${collision} and ${value}`);
    }
    folded.set(lower, value);
    exact.add(value);
  }
  return exact;
}

export function validatePodTemplate(template) {
  assertPlainObject(template, "pod template");
  assertExactFields(template, TEMPLATE_FIELDS, "pod template");
  if (template.version !== 1) fail("pod template version must be 1");
  if (!NAME.test(template.name)) {
    fail("pod template name must use lowercase letters, numbers, and dashes");
  }
  assertInteger(template.maxAttempts, 1, 10, "maxAttempts");

  assertPlainObject(template.timeouts, "timeouts");
  assertExactFields(template.timeouts, TIMEOUT_FIELDS, "timeouts");
  assertInteger(template.timeouts.executionSeconds, 10, 1_800, "timeouts.executionSeconds");
  assertInteger(
    template.timeouts.attemptSeconds,
    template.timeouts.executionSeconds,
    7_200,
    "timeouts.attemptSeconds",
  );
  assertInteger(
    template.timeouts.workflowSeconds,
    template.timeouts.attemptSeconds,
    43_200,
    "timeouts.workflowSeconds",
  );

  assertPlainObject(template.changes, "changes");
  assertExactFields(template.changes, CHANGE_FIELDS, "changes");
  assertInteger(template.changes.maxFiles, 1, 5_000, "changes.maxFiles");
  assertInteger(template.changes.maxBytes, 1_024, 104_857_600, "changes.maxBytes");

  assertPlainObject(template.writers, "writers");
  assertFixedKeys(template.writers, WRITER_IDS, "writers");
  const writeRoots = [];
  for (const writerId of WRITER_IDS) {
    const writer = template.writers[writerId];
    assertPlainObject(writer, `writer ${writerId}`);
    assertExactFields(writer, WRITER_FIELDS, `writer ${writerId}`);
    assertPromptPath(writer.prompt, `writer ${writerId} prompt`);
    if (!Array.isArray(writer.allowedWriteRoots) || writer.allowedWriteRoots.length !== 1) {
      fail(`writer ${writerId} allowedWriteRoots must contain exactly one directory`);
    }
    const root = writer.allowedWriteRoots[0];
    assertRepositoryDirectory(root, `writer ${writerId} allowedWriteRoots[0]`);
    for (const existing of writeRoots) {
      if (directoriesOverlap(existing.root, root)) {
        fail(`writer write roots overlap: ${existing.writerId}:${existing.root} and ${writerId}:${root}`);
      }
    }
    writeRoots.push({ writerId, root });
  }

  assertPlainObject(template.prompts, "prompts");
  assertFixedKeys(template.prompts, PROMPT_IDS, "prompts");
  for (const promptId of PROMPT_IDS) {
    assertPromptPath(template.prompts[promptId], `prompt ${promptId}`);
  }
  if (typeof template.verificationProfile !== "string") {
    fail("verificationProfile must be a string");
  }
  if (!VERIFICATION_PROFILES.has(template.verificationProfile)) {
    fail(`unsupported verificationProfile: ${template.verificationProfile}`);
  }
  return template;
}

export async function loadPodTemplate(name, { templateRoot } = {}) {
  if (!NAME.test(name)) fail("template name must use lowercase letters, numbers, and dashes");
  if (!templateRoot) fail("templateRoot is required");

  const root = await realpath(templateRoot);
  const templateDir = path.join(root, name);
  const templateStat = await lstat(templateDir).catch(() => null);
  if (!templateStat?.isDirectory() || templateStat.isSymbolicLink()) {
    fail(`unknown pod template: ${name}`);
  }
  const realTemplateDir = await realpath(templateDir);
  if (!descendant(root, realTemplateDir)) fail(`pod template escapes template root: ${name}`);

  const manifestPath = path.join(realTemplateDir, "pod.json");
  const manifestStat = await lstat(manifestPath).catch(() => null);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    fail(`pod template ${name} requires pod.json`);
  }
  const raw = await readFile(manifestPath, "utf8");
  if (Buffer.byteLength(raw) > 64 * 1024) fail("pod.json exceeds 64 KiB");
  let template;
  try {
    template = JSON.parse(raw);
  } catch (error) {
    fail(`invalid pod JSON: ${error.message}`);
  }
  validatePodTemplate(template);
  if (template.name !== name) {
    fail(`template directory ${name} does not match pod template name ${template.name}`);
  }

  const promptEntries = [
    ...WRITER_IDS.map(writerId => [writerId, template.writers[writerId].prompt]),
    ...PROMPT_IDS.map(promptId => [promptId, template.prompts[promptId]]),
  ];
  const prompts = {};
  const hash = createHash("sha256").update(raw);
  for (const [promptId, relative] of promptEntries) {
    const promptPath = path.join(realTemplateDir, ...relative.split("/"));
    const promptStat = await lstat(promptPath).catch(() => null);
    if (!promptStat?.isFile() || promptStat.isSymbolicLink()) {
      fail(`pod prompt ${promptId} must be a regular file`);
    }
    const realPrompt = await realpath(promptPath);
    if (!descendant(realTemplateDir, realPrompt)) fail(`pod prompt ${promptId} escapes template`);
    const prompt = await readFile(realPrompt, "utf8");
    assertText(prompt, `pod prompt ${promptId}`, 32 * 1024);
    prompts[promptId] = prompt;
    hash.update(`\0${promptId}\0${relative}\0${prompt}`);
  }
  const templateDigest = hash.digest("hex");
  return {
    template,
    templateDir: realTemplateDir,
    prompts,
    digest: templateDigest,
    templateDigest,
  };
}

export function validateAttemptPlan(plan, {
  template,
  runBaseSha,
  existingDirectories,
} = {}) {
  validatePodTemplate(template);
  assertGitSha(runBaseSha, "runBaseSha");
  const directories = validateExistingDirectories(existingDirectories);

  assertPlainObject(plan, "attempt plan");
  assertExactFields(plan, PLAN_FIELDS, "attempt plan");
  if (plan.version !== 1) fail("attempt plan version must be 1");
  assertInteger(plan.attempt, 1, template.maxAttempts, "attempt");
  assertGitSha(plan.baseSha, "attempt plan baseSha");
  if (plan.baseSha !== runBaseSha) fail("attempt plan baseSha must equal the immutable run base");

  if (!Array.isArray(plan.requirements) || !plan.requirements.length || plan.requirements.length > 50) {
    fail("requirements must contain 1 to 50 records");
  }
  const requirementIds = new Set();
  for (let index = 0; index < plan.requirements.length; index += 1) {
    const requirement = plan.requirements[index];
    assertPlainObject(requirement, `requirements[${index}]`);
    assertExactFields(requirement, REQUIREMENT_FIELDS, `requirements[${index}]`);
    assertTraceId(requirement.id, `requirements[${index}].id`);
    if (requirementIds.has(requirement.id)) fail(`duplicate requirement ID: ${requirement.id}`);
    requirementIds.add(requirement.id);
    assertText(requirement.text, `requirements[${index}].text`, 4_000);
  }

  if (!Array.isArray(plan.acceptanceCriteria)
      || !plan.acceptanceCriteria.length
      || plan.acceptanceCriteria.length > 100) {
    fail("acceptanceCriteria must contain 1 to 100 records");
  }
  const acceptanceIds = new Set();
  const acceptanceRequirements = new Map();
  const requirementsWithAcceptance = new Set();
  for (let index = 0; index < plan.acceptanceCriteria.length; index += 1) {
    const criterion = plan.acceptanceCriteria[index];
    assertPlainObject(criterion, `acceptanceCriteria[${index}]`);
    assertExactFields(criterion, ACCEPTANCE_FIELDS, `acceptanceCriteria[${index}]`);
    assertTraceId(criterion.id, `acceptanceCriteria[${index}].id`);
    if (acceptanceIds.has(criterion.id)) fail(`duplicate acceptance ID: ${criterion.id}`);
    acceptanceIds.add(criterion.id);
    const linkedRequirements = validateIdArray(
        criterion.requirementIds,
        requirementIds,
        `acceptanceCriteria[${index}].requirementIds`,
        { maximum: 50 },
      );
    acceptanceRequirements.set(criterion.id, linkedRequirements);
    for (const requirementId of linkedRequirements) requirementsWithAcceptance.add(requirementId);
    assertText(criterion.text, `acceptanceCriteria[${index}].text`, 4_000);
  }

  assertPlainObject(plan.writers, "attempt writers");
  assertFixedKeys(plan.writers, WRITER_IDS, "attempt writers");
  const claimed = [];
  const coveredRequirements = new Set();
  const coveredAcceptance = new Set();
  for (const writerId of WRITER_IDS) {
    const writer = plan.writers[writerId];
    assertPlainObject(writer, `attempt writer ${writerId}`);
    assertExactFields(writer, PLAN_WRITER_FIELDS, `attempt writer ${writerId}`);
    assertText(writer.brief, `attempt writer ${writerId} brief`, 8_000);
    const writerRequirements = validateIdArray(
      writer.requirementIds,
      requirementIds,
      `attempt writer ${writerId} requirementIds`,
      { maximum: 50 },
    );
    const writerAcceptance = validateIdArray(
      writer.acceptanceIds,
      acceptanceIds,
      `attempt writer ${writerId} acceptanceIds`,
    );
    for (const acceptanceId of writerAcceptance) {
      for (const requirementId of acceptanceRequirements.get(acceptanceId)) {
        if (!writerRequirements.has(requirementId)) {
          fail(`attempt writer ${writerId} acceptance ${acceptanceId} requires ${requirementId}`);
        }
      }
      coveredAcceptance.add(acceptanceId);
    }
    for (const requirementId of writerRequirements) coveredRequirements.add(requirementId);

    if (!Array.isArray(writer.writePaths) || !writer.writePaths.length || writer.writePaths.length > 20) {
      fail(`attempt writer ${writerId} writePaths must contain 1 to 20 directories`);
    }
    const allowedRoots = template.writers[writerId].allowedWriteRoots;
    for (const root of allowedRoots) {
      if (!directories.has(root)) fail(`template write root does not exist: ${writerId}:${root}`);
    }
    for (let index = 0; index < writer.writePaths.length; index += 1) {
      const writePath = writer.writePaths[index];
      assertRepositoryDirectory(writePath, `attempt writer ${writerId} writePaths[${index}]`);
      if (!directories.has(writePath)) {
        fail(`attempt writer ${writerId} writePath is not an existing directory: ${writePath}`);
      }
      if (!allowedRoots.some(root => directoryContains(root, writePath))) {
        fail(`attempt writer ${writerId} writePath is outside its template-owned root: ${writePath}`);
      }
      for (const existing of claimed) {
        if (directoriesOverlap(existing.path, writePath)) {
          fail(`attempt writePaths overlap: ${existing.writerId}:${existing.path} and ${writerId}:${writePath}`);
        }
      }
      claimed.push({ writerId, path: writePath });
    }
  }

  for (const requirementId of requirementIds) {
    if (!requirementsWithAcceptance.has(requirementId)) {
      fail(`requirement has no acceptance criterion: ${requirementId}`);
    }
    if (!coveredRequirements.has(requirementId)) fail(`requirement is not assigned to a writer: ${requirementId}`);
  }
  for (const acceptanceId of acceptanceIds) {
    if (!coveredAcceptance.has(acceptanceId)) fail(`acceptance criterion is not assigned to a writer: ${acceptanceId}`);
  }
  return plan;
}

export function validateWriterReceipt(receipt, {
  template,
  plan,
  writerId,
  executionBaseSha,
  deliveredInbox = [],
  previousInboxCursor = 0,
} = {}) {
  validatePodTemplate(template);
  assertPlainObject(plan, "attempt plan");
  if (!WRITER_IDS.includes(writerId) || !isPlainObject(plan.writers?.[writerId])) {
    fail(`unknown attempt writer: ${writerId}`);
  }
  assertGitSha(executionBaseSha, "executionBaseSha");
  if (!Array.isArray(deliveredInbox)) fail("deliveredInbox must be an array");
  assertInteger(previousInboxCursor, 0, Number.MAX_SAFE_INTEGER, "previousInboxCursor");

  assertPlainObject(receipt, "writer receipt");
  assertExactFields(receipt, WRITER_RECEIPT_FIELDS, "writer receipt");
  if (!["completed", "blocked", "failed"].includes(receipt.outcome)) {
    fail("writer receipt outcome must be completed, blocked, or failed");
  }
  assertGitSha(receipt.baseSha, "writer receipt baseSha");
  if (receipt.baseSha !== executionBaseSha) {
    fail("writer receipt baseSha must equal the execution base");
  }
  assertText(receipt.what, "writer receipt what");
  assertText(receipt.why, "writer receipt why");
  validateEvidence(receipt.evidence, "writer receipt evidence");

  const writer = plan.writers[writerId];
  assertExactStringArray(receipt.requirementIds, writer.requirementIds, "writer receipt requirementIds");
  assertExactStringArray(receipt.acceptanceIds, writer.acceptanceIds, "writer receipt acceptanceIds");

  const expectedCursor = validateDeliveredInbox(deliveredInbox, {
    plan,
    owner: writerId,
    previousInboxCursor,
  });
  assertInteger(receipt.inboxCursor, 0, Number.MAX_SAFE_INTEGER, "writer receipt inboxCursor");
  if (receipt.inboxCursor !== expectedCursor) {
    fail(`writer receipt inboxCursor must equal delivered cursor ${expectedCursor}`);
  }
  if (receipt.outcome === "blocked") {
    if (!isPlainObject(receipt.dependencyRequest)) {
      fail("blocked writer receipt requires dependencyRequest");
    }
    validateDependencyRequest(receipt.dependencyRequest, { plan, writerId });
  } else if (receipt.dependencyRequest !== null) {
    fail("non-blocked writer receipt dependencyRequest must be null");
  }

  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) {
    fail(`writer receipt must serialize to at most ${MAX_RECEIPT_BYTES} bytes`);
  }
  return receipt;
}

export function validateCheckerReceipt(receipt, {
  plan,
  writerId,
  baseSha,
  resultSha,
  diffSha256,
  deliveredInbox = [],
  previousInboxCursor = 0,
} = {}) {
  assertPlainObject(plan, "attempt plan");
  if (!WRITER_IDS.includes(writerId) || !isPlainObject(plan.writers?.[writerId])) {
    fail(`unknown attempt writer: ${writerId}`);
  }
  assertGitSha(baseSha, "checker baseSha");
  assertGitSha(resultSha, "checker resultSha");
  if (typeof diffSha256 !== "string" || !/^[a-f0-9]{64}$/.test(diffSha256)) {
    fail("checker diffSha256 must be a lowercase SHA-256 digest");
  }
  assertInteger(previousInboxCursor, 0, Number.MAX_SAFE_INTEGER, "previousInboxCursor");
  validateDeliveredInbox(deliveredInbox, {
    plan,
    owner: writerId,
    previousInboxCursor,
  });

  assertPlainObject(receipt, "checker receipt");
  assertExactFields(receipt, CHECKER_RECEIPT_FIELDS, "checker receipt");
  if (!["passed", "failed"].includes(receipt.outcome)) {
    fail("checker receipt outcome must be passed or failed");
  }
  assertGitSha(receipt.baseSha, "checker receipt baseSha");
  if (receipt.baseSha !== baseSha) fail("checker receipt baseSha must equal the checked base");
  assertGitSha(receipt.resultSha, "checker receipt resultSha");
  if (receipt.resultSha !== resultSha) fail("checker receipt resultSha must equal the checked result");
  if (receipt.diffSha256 !== diffSha256) {
    fail("checker receipt diffSha256 must equal the checked diff");
  }
  assertText(receipt.what, "checker receipt what");
  assertText(receipt.why, "checker receipt why");
  validateEvidence(receipt.evidence, "checker receipt evidence");
  const writer = plan.writers[writerId];
  assertExactStringArray(receipt.requirementIds, writer.requirementIds, "checker receipt requirementIds");
  assertExactStringArray(receipt.acceptanceIds, writer.acceptanceIds, "checker receipt acceptanceIds");
  if (!Array.isArray(receipt.files) || receipt.files.length !== 0) {
    fail("checker receipt files must be empty");
  }
  if (canonicalJson(receipt.deliveredInbox) !== canonicalJson(deliveredInbox)) {
    fail("checker receipt deliveredInbox must exactly match the controller-delivered slice");
  }
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) {
    fail(`checker receipt must serialize to at most ${MAX_RECEIPT_BYTES} bytes`);
  }
  return receipt;
}

export function validateConformanceReceipt(receipt, {
  plan,
  gate,
  candidateSha,
} = {}) {
  assertPlainObject(plan, "attempt plan");
  if (!["qa", "testing"].includes(gate)) fail("conformance gate must be qa or testing");
  assertGitSha(candidateSha, "conformance candidateSha");

  assertPlainObject(receipt, "conformance receipt");
  assertExactFields(receipt, CONFORMANCE_RECEIPT_FIELDS, "conformance receipt");
  if (receipt.gate !== gate) fail(`conformance receipt gate must equal ${gate}`);
  const outcomes = gate === "qa"
    ? ["passed", "test_defect", "product_nonconformance"]
    : ["passed", "failed"];
  if (!outcomes.includes(receipt.outcome)) {
    fail(gate === "qa"
      ? "QA outcome must be passed, test_defect, or product_nonconformance"
      : "Testing outcome must be passed or failed");
  }
  assertGitSha(receipt.candidateSha, "conformance receipt candidateSha");
  if (receipt.candidateSha !== candidateSha) {
    fail("conformance receipt candidateSha must equal the checked candidate");
  }
  assertText(receipt.what, "conformance receipt what");
  assertText(receipt.why, "conformance receipt why");
  validateEvidence(receipt.evidence, "conformance receipt evidence");
  const requirementIds = plan.requirements.map(item => item.id);
  const acceptanceIds = plan.acceptanceCriteria.map(item => item.id);
  assertExactStringArray(
    receipt.requirementIds,
    requirementIds,
    "conformance receipt requirementIds",
  );
  assertExactStringArray(
    receipt.acceptanceIds,
    acceptanceIds,
    "conformance receipt acceptanceIds",
  );
  if (!Array.isArray(receipt.files) || receipt.files.length !== 0) {
    fail("conformance receipt files must be empty");
  }
  if (Buffer.byteLength(JSON.stringify(receipt)) > MAX_RECEIPT_BYTES) {
    fail(`conformance receipt must serialize to at most ${MAX_RECEIPT_BYTES} bytes`);
  }
  return receipt;
}
