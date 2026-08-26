import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubPublisher,
  parseGitHubRepository,
} from "../src/github-publisher.mjs";

const OWNER = "acme";
const REPOSITORY_NAME = "widgets";
const REPOSITORY = `https://github.com/${OWNER}/${REPOSITORY_NAME}`;
const TARGET_BRANCH = "main";
const HEAD_BRANCH = "bimo/run-123";
const HEAD_SHA = "a".repeat(40);
const STALE_SHA = "b".repeat(40);
const BASE_SHA = "c".repeat(40);
const STALE_BASE_SHA = "d".repeat(40);
const TOKEN = "test-token-not-a-credential";

function deadline(milliseconds = 1_000) {
  return Date.now() + milliseconds;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function branchResponse(branch, sha) {
  return jsonResponse({
    ref: `refs/heads/${branch}`,
    object: {
      sha,
      type: "commit",
      url: `https://api.github.com/repos/${OWNER}/${REPOSITORY_NAME}/git/commits/${sha}`,
    },
  });
}

function pullResponse({
  sha = HEAD_SHA,
  baseSha = BASE_SHA,
  headBranch = HEAD_BRANCH,
  baseBranch = TARGET_BRANCH,
  owner = OWNER,
  repositoryName = REPOSITORY_NAME,
  headRepository = `${owner}/${repositoryName}`,
  baseRepository = `${owner}/${repositoryName}`,
  number = 17,
  state = "open",
  draft = true,
  url = `https://github.com/${owner}/${repositoryName}/pull/${number}`,
} = {}) {
  return {
    number,
    html_url: url,
    state,
    draft,
    head: {
      ref: headBranch,
      sha,
      repo: { full_name: headRepository },
    },
    base: {
      ref: baseBranch,
      sha: baseSha,
      repo: { full_name: baseRepository },
    },
  };
}

function scriptedFetch(steps) {
  const calls = [];
  const remaining = [...steps];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const step = remaining.shift();
    assert.notEqual(step, undefined, "unexpected fetch call");
    return typeof step === "function" ? step(url, options) : step;
  };
  return { calls, fetchImpl, remaining };
}

function publisher(fetchImpl) {
  return createGitHubPublisher({
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    token: TOKEN,
    fetchImpl,
  });
}

function publishInput(overrides = {}) {
  return {
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    baseSha: BASE_SHA,
    draft: true,
    title: "Publish the generated application",
    body: "Created by the bounded Bimo workflow.",
    deadlineAt: deadline(),
    ...overrides,
  };
}

test("parses only a canonical allowlisted github.com repository", () => {
  assert.deepEqual(parseGitHubRepository(REPOSITORY), {
    owner: OWNER,
    repo: REPOSITORY_NAME,
  });
  assert.deepEqual(parseGitHubRepository(`${REPOSITORY}.git`), {
    owner: OWNER,
    repo: REPOSITORY_NAME,
  });

  for (const repository of [
    `http://github.com/${OWNER}/${REPOSITORY_NAME}`,
    `https://github.com.evil.test/${OWNER}/${REPOSITORY_NAME}`,
    `https://user:password@github.com/${OWNER}/${REPOSITORY_NAME}`,
    `https://github.com/${OWNER}/${REPOSITORY_NAME}/extra`,
    `https://github.com/${OWNER}/${REPOSITORY_NAME}?tab=readme`,
    `https://github.com/${OWNER}/${REPOSITORY_NAME}#readme`,
    `https://github.com/${OWNER}%2fescape/${REPOSITORY_NAME}`,
    `git@github.com:${OWNER}/${REPOSITORY_NAME}.git`,
  ]) {
    assert.throws(
      () => parseGitHubRepository(repository),
      /invalid GitHub repository/,
      repository,
    );
  }
});

test("rejects invalid configuration and publish input before network access", async () => {
  const fetchCalls = [];
  const fetchImpl = async (...args) => {
    fetchCalls.push(args);
    throw new Error("must not be called");
  };

  assert.throws(
    () =>
      createGitHubPublisher({
        repository: "https://evil.test/acme/widgets",
        targetBranch: TARGET_BRANCH,
        token: TOKEN,
        fetchImpl,
      }),
    /invalid GitHub repository/,
  );
  assert.throws(
    () =>
      createGitHubPublisher({
        repository: REPOSITORY,
        targetBranch: "refs/heads/main",
        token: TOKEN,
        fetchImpl,
      }),
    /invalid targetBranch/,
  );
  assert.throws(
    () =>
      createGitHubPublisher({
        repository: REPOSITORY,
        targetBranch: TARGET_BRANCH,
        token: `${TOKEN}\nsecond-line`,
        fetchImpl,
      }),
    /invalid token/,
  );
  assert.throws(
    () =>
      createGitHubPublisher({
        repository: REPOSITORY,
        targetBranch: TARGET_BRANCH,
        token: TOKEN,
        fetchImpl: null,
      }),
    /fetchImpl must be a function/,
  );

  const github = publisher(fetchImpl);
  for (const overrides of [
    { headBranch: TARGET_BRANCH },
    { headBranch: "../escape" },
    { headBranch: "HEAD" },
    { headBranch: "bimo//run" },
    { headBranch: "bimo/run.lock" },
    { headSha: HEAD_SHA.toUpperCase() },
    { headSha: "abc123" },
    { baseSha: BASE_SHA.toUpperCase() },
    { baseSha: "abc123" },
    { draft: false },
    { draft: undefined },
    { draft: "true" },
    { title: "   " },
    { title: "x".repeat(257) },
    { body: "x".repeat(65_537) },
    { deadlineAt: Date.now() - 1 },
    { deadlineAt: Number.MAX_VALUE },
  ]) {
    await assert.rejects(github.publish(publishInput(overrides)));
  }
  assert.equal(fetchCalls.length, 0);
});

test("binds immutable base and head refs before creating one pull request", async () => {
  const pull = pullResponse();
  const { calls, fetchImpl, remaining } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([]),
    jsonResponse(pull, 201),
  ]);

  const result = await publisher(fetchImpl).publish(publishInput());

  assert.deepEqual(result, {
    number: pull.number,
    url: pull.html_url,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
  });
  assert.equal(remaining.length, 0);
  assert.equal(calls.length, 4);
  assert.equal(
    calls[0].url,
    `https://api.github.com/repos/${OWNER}/${REPOSITORY_NAME}/git/ref/heads/main`,
  );
  assert.equal(
    calls[1].url,
    `https://api.github.com/repos/${OWNER}/${REPOSITORY_NAME}/git/ref/heads/bimo%2Frun-123`,
  );
  assert.equal(
    calls[2].url,
    `https://api.github.com/repos/${OWNER}/${REPOSITORY_NAME}/pulls?state=all&head=acme%3Abimo%2Frun-123&per_page=100`,
  );
  assert.equal(calls[3].options.method, "POST");
  assert.equal(
    calls[3].url,
    `https://api.github.com/repos/${OWNER}/${REPOSITORY_NAME}/pulls`,
  );
  assert.deepEqual(JSON.parse(calls[3].options.body), {
    title: "Publish the generated application",
    body: "Created by the bounded Bimo workflow.",
    head: HEAD_BRANCH,
    base: TARGET_BRANCH,
    draft: true,
  });

  for (const call of calls) {
    const headers = new Headers(call.options.headers);
    assert.equal(headers.get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(call.options.redirect, "error");
    assert(call.options.signal instanceof AbortSignal);
  }
  assert.equal(calls[3].options.body.includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("returns an existing pull request only when its head SHA is exact", async () => {
  const pull = pullResponse();
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([pull]),
  ]);

  const result = await publisher(fetchImpl).publish(publishInput());

  assert.deepEqual(result, {
    number: pull.number,
    url: pull.html_url,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: false,
  });
  assert.equal(calls.length, 3);
  assert.equal(calls.some(({ options }) => options.method === "POST"), false);
});

test("fails closed on a stale pull request without posting another", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([pullResponse({ sha: STALE_SHA })]),
  ]);

  await assert.rejects(
    publisher(fetchImpl).publish(publishInput()),
    /existing pull request conflicts with publication contract/,
  );
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    0,
  );
});

test("fails closed on closed or wrong-base pull requests", async (t) => {
  for (const [name, conflictingPull] of [
    ["closed", pullResponse({ state: "closed" })],
    ["wrong base", pullResponse({ baseSha: STALE_BASE_SHA })],
    ["wrong base branch", pullResponse({ baseBranch: "develop" })],
    ["wrong base repository", pullResponse({ baseRepository: "acme/other" })],
    ["non-draft", pullResponse({ draft: false })],
  ]) {
    await t.test(name, async () => {
      const { calls, fetchImpl } = scriptedFetch([
        branchResponse(TARGET_BRANCH, BASE_SHA),
        branchResponse(HEAD_BRANCH, HEAD_SHA),
        jsonResponse([conflictingPull]),
      ]);
      await assert.rejects(
        publisher(fetchImpl).publish(publishInput()),
        /existing pull request conflicts with publication contract/,
      );
      assert.equal(
        calls.some(({ options }) => options.method === "POST"),
        false,
      );
    });
  }
});

test("fails closed when all-state lookup is not uniquely exact", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([
      pullResponse({ number: 17 }),
      pullResponse({ number: 18 }),
    ]),
  ]);

  await assert.rejects(
    publisher(fetchImpl).publish(publishInput()),
    /existing pull request conflicts with publication contract/,
  );
  assert.equal(calls.some(({ options }) => options.method === "POST"), false);
});

test("stops before head lookup when the immutable base ref moved", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, STALE_BASE_SHA),
  ]);

  await assert.rejects(
    publisher(fetchImpl).publish(publishInput()),
    /remote base does not match baseSha/,
  );
  assert.equal(calls.length, 1);
});

test("stops before pull-request lookup when the remote head does not match", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, STALE_SHA),
  ]);

  await assert.rejects(
    publisher(fetchImpl).publish(publishInput()),
    /remote head does not match headSha/,
  );
  assert.equal(calls.length, 2);
});

test("reconciles an ambiguous create without issuing a second POST", async () => {
  const pull = pullResponse({ number: 19 });
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([]),
    () => {
      throw new Error(`socket closed while using ${TOKEN}`);
    },
    branchResponse(TARGET_BRANCH, BASE_SHA),
    jsonResponse([pull]),
  ]);

  const result = await publisher(fetchImpl).publish(publishInput());

  assert.deepEqual(result, {
    number: pull.number,
    url: pull.html_url,
    headBranch: HEAD_BRANCH,
    headSha: HEAD_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
    reconciled: true,
  });
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
  assert.equal(calls.length, 6);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
});

test("fails closed when create returns a draft bound to a moved base", async () => {
  const movedBasePull = pullResponse({ number: 20, baseSha: STALE_BASE_SHA });
  const { calls, fetchImpl, remaining } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([]),
    jsonResponse(movedBasePull, 201),
    branchResponse(TARGET_BRANCH, BASE_SHA),
    jsonResponse([movedBasePull]),
  ]);

  await assert.rejects(
    publisher(fetchImpl).publish(publishInput()),
    /GitHub pull request creation failed/,
  );

  assert.equal(remaining.length, 0);
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
  assert.equal(calls.length, 6);
});

test("uses a separate bounded reconciliation window after POST deadline", async () => {
  const pull = pullResponse({ number: 21 });
  let postSignal;
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([]),
    (_url, { signal }) => {
      postSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new Error(`POST timeout ${TOKEN}`)),
          { once: true },
        );
      });
    },
    branchResponse(TARGET_BRANCH, BASE_SHA),
    jsonResponse([pull]),
  ]);

  const result = await publisher(fetchImpl).publish(
    publishInput({ deadlineAt: Date.now() + 250 }),
  );

  assert.equal(postSignal.aborted, true);
  assert.equal(result.number, pull.number);
  assert.equal(result.reconciled, true);
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
  assert.equal(calls.length, 6);
});

test("fails closed after an ambiguous create cannot be reconciled", async () => {
  const { calls, fetchImpl } = scriptedFetch([
    branchResponse(TARGET_BRANCH, BASE_SHA),
    branchResponse(HEAD_BRANCH, HEAD_SHA),
    jsonResponse([]),
    jsonResponse({ error: TOKEN }, 502),
    branchResponse(TARGET_BRANCH, BASE_SHA),
    jsonResponse([]),
  ]);

  await assert.rejects(
    publisher(fetchImpl).publish(publishInput()),
    (error) => {
      assert.match(error.message, /pull request creation failed/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );
  assert.equal(
    calls.filter(({ options }) => options.method === "POST").length,
    1,
  );
});

test("rejects redirects, oversized responses, and unexpected response shapes", async (t) => {
  await t.test("redirect", async () => {
    const { calls, fetchImpl } = scriptedFetch([
      new Response(null, {
        status: 302,
        headers: { location: "https://attacker.invalid/steal" },
      }),
    ]);
    await assert.rejects(
      publisher(fetchImpl).publish(publishInput()),
      /redirect response rejected/,
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.redirect, "error");
  });

  await t.test("already-followed redirect", async () => {
    const followed = branchResponse(TARGET_BRANCH, BASE_SHA);
    const { fetchImpl } = scriptedFetch([{
      status: followed.status,
      headers: followed.headers,
      body: followed.body,
      redirected: true,
    }]);
    await assert.rejects(
      publisher(fetchImpl).publish(publishInput()),
      /redirect response rejected/,
    );
  });

  await t.test("oversized body", async () => {
    const { fetchImpl } = scriptedFetch([
      new Response("x".repeat(300_000), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ]);
    await assert.rejects(
      publisher(fetchImpl).publish(publishInput()),
      /GitHub response too large/,
    );
  });

  await t.test("malformed pull request", async () => {
    const malformed = pullResponse({ url: "javascript:alert(1)" });
    const { calls, fetchImpl } = scriptedFetch([
      branchResponse(TARGET_BRANCH, BASE_SHA),
      branchResponse(HEAD_BRANCH, HEAD_SHA),
      jsonResponse([malformed]),
    ]);
    await assert.rejects(
      publisher(fetchImpl).publish(publishInput()),
      /unexpected GitHub response/,
    );
    assert.equal(calls.length, 3);
  });
});

test("enforces one absolute deadline across network and body work", async () => {
  let observedSignal;
  const fetchImpl = async (_url, { signal }) => {
    observedSignal = signal;
    return new Promise((_resolve, reject) => {
      signal.addEventListener(
        "abort",
        () => reject(new Error(`upstream abort ${TOKEN}`)),
        { once: true },
      );
    });
  };
  const startedAt = Date.now();

  await assert.rejects(
    publisher(fetchImpl).publish(
      publishInput({ deadlineAt: Date.now() + 50 }),
    ),
    (error) => {
      assert.match(error.message, /deadline exceeded/);
      assert.equal(error.message.includes(TOKEN), false);
      return true;
    },
  );

  assert(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert(Date.now() - startedAt < 500, "deadline should bound total work");
});
