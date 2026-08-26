const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_WEB_ORIGIN = "https://github.com";
const GITHUB_API_VERSION = "2022-11-28";
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_BYTES = 4_096;
const MAX_TITLE_BYTES = 256;
const MAX_BODY_BYTES = 65_536;
const MAX_BRANCH_BYTES = 255;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const RECONCILIATION_WINDOW_MS = 2_000;

class PublisherError extends Error {}

class DeadlineExceededError extends PublisherError {
  constructor() {
    super("GitHub publisher deadline exceeded");
  }
}

class RequestFailedError extends PublisherError {
  constructor() {
    super("GitHub request failed");
  }
}

class RedirectRejectedError extends PublisherError {
  constructor() {
    super("GitHub redirect response rejected");
  }
}

class ResponseTooLargeError extends PublisherError {
  constructor() {
    super("GitHub response too large");
  }
}

class UnexpectedResponseError extends PublisherError {
  constructor() {
    super("unexpected GitHub response");
  }
}

class UnexpectedStatusError extends PublisherError {
  constructor(status) {
    super(`GitHub request returned unexpected status ${status}`);
  }
}

class ExistingPullConflictError extends PublisherError {
  constructor() {
    super("existing pull request conflicts with publication contract");
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidRepository() {
  throw new TypeError("invalid GitHub repository");
}

export function parseGitHubRepository(repository) {
  if (
    typeof repository !== "string" ||
    repository.length === 0 ||
    repository.length > 512 ||
    repository !== repository.trim()
  ) {
    invalidRepository();
  }

  let url;
  try {
    url = new URL(repository);
  } catch {
    invalidRepository();
  }

  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname.includes("%")
  ) {
    invalidRepository();
  }

  const match = /^\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
  if (match === null) invalidRepository();

  const owner = match[1];
  let repo = match[2];
  if (repo.endsWith(".git")) repo = repo.slice(0, -4);

  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(owner) ||
    !/^[A-Za-z0-9._-]{1,100}$/u.test(repo) ||
    repo === "." ||
    repo === ".."
  ) {
    invalidRepository();
  }

  return Object.freeze({ owner, repo });
}

function validateBranch(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_BRANCH_BYTES ||
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(value) ||
    value === "HEAD" ||
    value.startsWith("refs/") ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.split("/").some((component) =>
      component.length === 0 ||
      component.startsWith(".") ||
      component.endsWith(".lock")
    )
  ) {
    throw new TypeError(`invalid ${label}`);
  }
  return value;
}

function validateToken(token) {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    Buffer.byteLength(token) > MAX_TOKEN_BYTES ||
    !/^[\u0021-\u007e]+$/u.test(token)
  ) {
    throw new TypeError("invalid token");
  }
  return token;
}

function validateSha(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new TypeError(`invalid ${label}`);
  }
  return value;
}

function validateTitle(value, token) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value) > MAX_TITLE_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    value.includes(token)
  ) {
    throw new TypeError("invalid title");
  }
  return value;
}

function validateBody(value, token) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_BODY_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
    value.includes(token)
  ) {
    throw new TypeError("invalid body");
  }
  return value;
}

function validateDeadline(deadlineAt) {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= Date.now()) {
    throw new TypeError("deadlineAt must be a future safe integer");
  }
  return deadlineAt;
}

async function withinDeadline(deadlineAt, operation) {
  if (deadlineAt <= Date.now()) throw new DeadlineExceededError();

  const controller = new AbortController();
  let timer;
  let rejectDeadline;
  const deadlinePromise = new Promise((_resolve, reject) => {
    rejectDeadline = reject;
  });

  const schedule = () => {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      controller.abort();
      rejectDeadline(new DeadlineExceededError());
      return;
    }
    timer = setTimeout(schedule, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  schedule();

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      deadlinePromise,
    ]);
    if (Date.now() >= deadlineAt) {
      controller.abort();
      throw new DeadlineExceededError();
    }
    return result;
  } catch (error) {
    if (controller.signal.aborted || Date.now() >= deadlineAt) {
      throw new DeadlineExceededError();
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function requireResponseShape(response) {
  if (
    response === null ||
    typeof response !== "object" ||
    !Number.isInteger(response.status) ||
    response.status < 100 ||
    response.status > 599 ||
    response.headers === null ||
    typeof response.headers !== "object" ||
    typeof response.headers.get !== "function" ||
    (response.redirected !== undefined &&
      typeof response.redirected !== "boolean")
  ) {
    throw new UnexpectedResponseError();
  }
}

function declaredResponseLength(headers) {
  const value = headers.get("content-length");
  if (value === null) return null;
  if (!/^\d+$/u.test(value)) throw new UnexpectedResponseError();
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new UnexpectedResponseError();
  return length;
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // The response is already being rejected; cancellation is best-effort.
  }
}

async function readBoundedResponse(response) {
  const declaredLength = declaredResponseLength(response.headers);
  if (declaredLength !== null && declaredLength > MAX_RESPONSE_BYTES) {
    try {
      await response.body.cancel();
    } catch {
      // The size check is authoritative even if cancellation fails.
    }
    throw new ResponseTooLargeError();
  }

  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;

  for (;;) {
    const result = await reader.read();
    if (!isPlainObject(result) || typeof result.done !== "boolean") {
      await cancelReader(reader);
      throw new UnexpectedResponseError();
    }
    if (result.done) break;
    if (!(result.value instanceof Uint8Array)) {
      await cancelReader(reader);
      throw new UnexpectedResponseError();
    }
    totalBytes += result.value.byteLength;
    if (totalBytes > MAX_RESPONSE_BYTES) {
      await cancelReader(reader);
      throw new ResponseTooLargeError();
    }
    chunks.push(
      Buffer.from(
        result.value.buffer,
        result.value.byteOffset,
        result.value.byteLength,
      ),
    );
  }

  return Buffer.concat(chunks, totalBytes);
}

function decodeJson(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new UnexpectedResponseError();
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new UnexpectedResponseError();
  }
}

function hasJsonContentType(headers) {
  const value = headers.get("content-type");
  if (typeof value !== "string") return false;
  const mediaType = value.split(";", 1)[0].trim().toLowerCase();
  return mediaType === "application/json" ||
    mediaType === "application/vnd.github+json";
}

function requestHeaders(token, hasBody) {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "monolith-v2",
    "x-github-api-version": GITHUB_API_VERSION,
    ...(hasBody ? { "content-type": "application/json" } : {}),
  };
}

function repositoryMatches(fullName, owner, repo) {
  return typeof fullName === "string" &&
    fullName.toLowerCase() === `${owner}/${repo}`.toLowerCase();
}

function validatePullUrl(value, owner, repo, number) {
  if (typeof value !== "string" || value.includes("%")) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.origin === GITHUB_WEB_ORIGIN &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname.toLowerCase() ===
      `/${owner}/${repo}/pull/${number}`.toLowerCase();
}

function validatePull(payload, { owner, repo, headBranch }) {
  if (
    !isPlainObject(payload) ||
    !Number.isSafeInteger(payload.number) ||
    payload.number <= 0 ||
    !["open", "closed"].includes(payload.state) ||
    typeof payload.draft !== "boolean" ||
    !validatePullUrl(payload.html_url, owner, repo, payload.number) ||
    !isPlainObject(payload.head) ||
    payload.head.ref !== headBranch ||
    typeof payload.head.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(payload.head.sha) ||
    !isPlainObject(payload.head.repo) ||
    typeof payload.head.repo.full_name !== "string" ||
    !isPlainObject(payload.base) ||
    typeof payload.base.ref !== "string" ||
    typeof payload.base.sha !== "string" ||
    !/^[a-f0-9]{40}$/u.test(payload.base.sha) ||
    !isPlainObject(payload.base.repo) ||
    typeof payload.base.repo.full_name !== "string"
  ) {
    throw new UnexpectedResponseError();
  }
  return payload;
}

function pullMatchesContract(pull, context) {
  return pull.state === "open" &&
    pull.draft === true &&
    pull.head.sha === context.headSha &&
    repositoryMatches(pull.head.repo.full_name, context.owner, context.repo) &&
    pull.base.ref === context.targetBranch &&
    pull.base.sha === context.baseSha &&
    repositoryMatches(pull.base.repo.full_name, context.owner, context.repo);
}

function normalizePull(pull, context, created, reconciled = false) {
  const result = {
    number: pull.number,
    url: pull.html_url,
    headBranch: context.headBranch,
    headSha: context.headSha,
    targetBranch: context.targetBranch,
    baseSha: context.baseSha,
    draft: true,
    created,
  };
  if (reconciled) result.reconciled = true;
  return Object.freeze(result);
}

export function createGitHubPublisher({
  repository,
  targetBranch,
  token,
  fetchImpl,
}) {
  const { owner, repo } = parseGitHubRepository(repository);
  const allowedTargetBranch = validateBranch(targetBranch, "targetBranch");
  const credential = validateToken(token);
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function");
  }

  const repositoryPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  async function requestJson(
    path,
    { deadlineAt, method = "GET", body, expectedStatus },
  ) {
    return withinDeadline(deadlineAt, async (signal) => {
      try {
        const response = await fetchImpl(`${GITHUB_API_ORIGIN}${path}`, {
          method,
          headers: requestHeaders(credential, body !== undefined),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: "error",
          signal,
        });
        requireResponseShape(response);
        if (
          response.redirected === true ||
          (response.status >= 300 && response.status < 400)
        ) {
          throw new RedirectRejectedError();
        }
        if (
          response.body === null ||
          typeof response.body !== "object" ||
          typeof response.body.getReader !== "function"
        ) {
          throw new UnexpectedResponseError();
        }
        const bytes = await readBoundedResponse(response);
        if (response.status !== expectedStatus) {
          throw new UnexpectedStatusError(response.status);
        }
        if (!hasJsonContentType(response.headers)) {
          throw new UnexpectedResponseError();
        }
        return decodeJson(bytes);
      } catch (error) {
        if (error instanceof PublisherError) throw error;
        throw new RequestFailedError();
      }
    });
  }

  async function readRemoteRef(branch, deadlineAt) {
    const payload = await requestJson(
      `${repositoryPath}/git/ref/heads/${encodeURIComponent(branch)}`,
      { deadlineAt, expectedStatus: 200 },
    );
    if (
      !isPlainObject(payload) ||
      payload.ref !== `refs/heads/${branch}` ||
      !isPlainObject(payload.object) ||
      payload.object.type !== "commit" ||
      typeof payload.object.sha !== "string" ||
      !/^[a-f0-9]{40}$/u.test(payload.object.sha)
    ) {
      throw new UnexpectedResponseError();
    }
    return payload.object.sha;
  }

  async function findExistingPull(context, deadlineAt) {
    const query = new URLSearchParams([
      ["state", "all"],
      ["head", `${owner}:${context.headBranch}`],
      ["per_page", "100"],
    ]);
    const payload = await requestJson(`${repositoryPath}/pulls?${query}`, {
      deadlineAt,
      expectedStatus: 200,
    });
    if (!Array.isArray(payload) || payload.length > 100) {
      throw new UnexpectedResponseError();
    }

    const pulls = payload.map((pull) => validatePull(pull, context));
    if (pulls.length === 0) return null;
    if (pulls.length !== 1 || !pullMatchesContract(pulls[0], context)) {
      throw new ExistingPullConflictError();
    }
    return pulls[0];
  }

  return Object.freeze({
    async publish(input) {
      if (!isPlainObject(input)) {
        throw new TypeError("publish input must be an object");
      }
      const headBranch = validateBranch(input.headBranch, "headBranch");
      if (headBranch === allowedTargetBranch) {
        throw new TypeError("headBranch must differ from targetBranch");
      }
      const headSha = validateSha(input.headSha, "headSha");
      const baseSha = validateSha(input.baseSha, "baseSha");
      if (input.draft !== true) {
        throw new TypeError("draft must be true");
      }
      const title = validateTitle(input.title, credential);
      const body = validateBody(input.body, credential);
      const deadlineAt = validateDeadline(input.deadlineAt);
      const context = {
        owner,
        repo,
        headBranch,
        headSha,
        targetBranch: allowedTargetBranch,
        baseSha,
      };

      const remoteBase = await readRemoteRef(allowedTargetBranch, deadlineAt);
      if (remoteBase !== baseSha) {
        throw new Error("remote base does not match baseSha");
      }

      const remoteHead = await readRemoteRef(headBranch, deadlineAt);
      if (remoteHead !== headSha) {
        throw new Error("remote head does not match headSha");
      }

      const existing = await findExistingPull(context, deadlineAt);
      if (existing !== null) {
        return normalizePull(existing, context, false);
      }

      try {
        const created = validatePull(
          await requestJson(`${repositoryPath}/pulls`, {
            deadlineAt,
            method: "POST",
            body: {
              title,
              body,
              head: headBranch,
              base: allowedTargetBranch,
              draft: true,
            },
            expectedStatus: 201,
          }),
          context,
        );
        if (!pullMatchesContract(created, context)) {
          throw new UnexpectedResponseError();
        }
        return normalizePull(created, context, true);
      } catch {
        // The POST may have reached GitHub even when its result was ambiguous.
      }

      const reconciliationDeadlineAt = Date.now() + RECONCILIATION_WINDOW_MS;
      try {
        const reconciledBase = await readRemoteRef(
          allowedTargetBranch,
          reconciliationDeadlineAt,
        );
        if (reconciledBase !== baseSha) {
          throw new Error("remote base changed during reconciliation");
        }
        const reconciled = await findExistingPull(
          context,
          reconciliationDeadlineAt,
        );
        if (reconciled !== null) {
          return normalizePull(reconciled, context, true, true);
        }
      } catch {
        // Reconciliation failures remain generic and cannot trigger another POST.
      }

      throw new Error("GitHub pull request creation failed");
    },
  });
}
