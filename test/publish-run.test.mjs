import assert from "node:assert/strict";
import { link, lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPodRunStore, openPodRunStore } from "../src/pod-store.mjs";
import { publishRun } from "../src/publish-run.mjs";

const REPOSITORY = "https://github.com/zaycruz/monolith-v2.git";
const TARGET_BRANCH = "main";
const HEAD_BRANCH = "monolith/run-1";
const BASE_SHA = "a".repeat(40);
const CANDIDATE_SHA = "b".repeat(40);
const OTHER_SHA = "c".repeat(40);
const TOKEN = "test-publish-token-must-stay-secret";

async function fixture(t, readyOverrides = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monolith-publish-run-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const stateRoot = path.join(temporary, "state");
  const sourceGitDir = path.join(temporary, "source.git");
  const askpassRoot = path.join(temporary, "tmpfs");
  await mkdir(sourceGitDir, { mode: 0o700 });
  const store = await createPodRunStore({
    stateRoot,
    runId: "run-1",
    assignment: { task: "Build the bounded change." },
  });
  await store.appendEvent("publication.ready", {
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    headBranch: HEAD_BRANCH,
    ...readyOverrides,
  });
  return {
    askpassRoot,
    input: {
      runId: "run-1",
      stateRoot,
      repository: REPOSITORY,
      targetBranch: TARGET_BRANCH,
      baseSha: BASE_SHA,
      candidateSha: CANDIDATE_SHA,
      headBranch: HEAD_BRANCH,
      sourceGitDir,
      token: TOKEN,
      deadlineAt: Date.now() + 10_000,
    },
  };
}

async function completedFixture(t) {
  const prepared = await fixture(t);
  const publication = {
    number: 46,
    url: "https://github.com/zaycruz/monolith-v2/pull/46",
    headBranch: HEAD_BRANCH,
    headSha: CANDIDATE_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
  };
  const store = await openPodRunStore({
    stateRoot: prepared.input.stateRoot,
    runId: prepared.input.runId,
  });
  const binding = {
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    headBranch: HEAD_BRANCH,
    publication,
  };
  await store.appendEvent("publication.finished", binding);
  await store.finish("completed", { phase: "published", ...binding });
  return { ...prepared, publication };
}

test("publication input is exact and rejects extra authority before opening the run", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  let opened = false;

  await assert.rejects(
    publishRun({ ...input, force: true }, {
      askpassRoot,
      openRunStore: async () => {
        opened = true;
        throw new Error("must not open the run");
      },
    }),
    /publish input must contain exactly/,
  );

  assert.equal(opened, false);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);

  await assert.rejects(
    publishRun({ ...input, sourceGitDir: input.stateRoot }, {
      askpassRoot,
      openRunStore: async () => {
        opened = true;
        throw new Error("must not open the run");
      },
    }),
    /sourceGitDir must not overlap stateRoot/,
  );
  assert.equal(opened, false);
});

test("a mismatched durable publication-ready receipt causes zero Git or API calls", async (t) => {
  const { askpassRoot, input } = await fixture(t, { candidateSha: OTHER_SHA });
  const gitCalls = [];
  const apiCalls = [];

  await assert.rejects(
    publishRun(input, {
      askpassRoot,
      gitRunner: async options => {
        gitCalls.push(options);
        throw new Error("must not run Git");
      },
      createGitHubPublisher: options => {
        apiCalls.push(options);
        return { publish: async () => ({}) };
      },
    }),
    /publication.ready does not match publication input/,
  );

  assert.deepEqual(gitCalls, []);
  assert.deepEqual(apiCalls, []);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
});

test("a stale remote head fails without force-pushing or calling GitHub", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  const gitCalls = [];
  const apiCalls = [];
  const gitRunner = async options => {
    gitCalls.push(options);
    if (gitCalls.length === 1) {
      return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
    }
    if (gitCalls.length === 2) {
      return {
        code: 0,
        stdout: [
          `${BASE_SHA}\trefs/heads/${TARGET_BRANCH}`,
          `${OTHER_SHA}\trefs/heads/${HEAD_BRANCH}`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    throw new Error("unexpected Git call");
  };

  await assert.rejects(
    publishRun(input, {
      askpassRoot,
      gitRunner,
      createGitHubPublisher: options => {
        apiCalls.push(options);
        return { publish: async () => ({}) };
      },
    }),
    /remote head branch already exists at another SHA/,
  );

  assert.equal(gitCalls.length, 2);
  assert.equal(gitCalls[0].args.includes(`${CANDIDATE_SHA}^{commit}`), true);
  assert.deepEqual(gitCalls[1].args.slice(-5), [
    "ls-remote",
    "--heads",
    REPOSITORY,
    `refs/heads/${TARGET_BRANCH}`,
    `refs/heads/${HEAD_BRANCH}`,
  ]);
  assert.equal(gitCalls.flatMap(call => call.args).some(arg => arg.includes("force")), false);
  assert.equal(JSON.stringify(gitCalls.map(call => call.args)).includes(TOKEN), false);
  assert.deepEqual(apiCalls, []);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
  assert.equal((await lstat(input.sourceGitDir)).isDirectory(), true);
});

test("the absolute deadline aborts and settles an in-flight Git inspection", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  input.deadlineAt = Date.now() + 150;
  let apiCalls = 0;

  await assert.rejects(
    publishRun(input, {
      askpassRoot,
      gitRunner: async options => {
        assert(options.signal instanceof AbortSignal);
        await new Promise(resolve => options.signal.addEventListener("abort", resolve, { once: true }));
        return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
      },
      createGitHubPublisher: () => {
        apiCalls += 1;
        return { publish: async () => ({}) };
      },
    }),
    /publication deadline exceeded/,
  );

  assert.equal(apiCalls, 0);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
});

test("an absent remote head is pushed from the exact candidate ref without force", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  const gitCalls = [];
  const gitRunner = async options => {
    gitCalls.push(options);
    if (gitCalls.length === 1) {
      return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
    }
    if (gitCalls.length === 2) {
      return {
        code: 0,
        stdout: `${BASE_SHA}\trefs/heads/${TARGET_BRANCH}\n`,
        stderr: "",
      };
    }
    if (gitCalls.length === 3) {
      return { code: 0, stdout: "ok refs/heads/monolith/run-1\n", stderr: "" };
    }
    throw new Error("unexpected Git call");
  };

  await assert.rejects(
    publishRun(input, {
      askpassRoot,
      gitRunner,
      createGitHubPublisher: () => ({
        publish: async () => { throw new Error("stop-after-exact-push"); },
      }),
    }),
    /stop-after-exact-push/,
  );

  assert.equal(gitCalls.length, 3);
  assert.deepEqual(gitCalls[2].args, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "credential.helper=",
    "-c", "credential.useHttpPath=true",
    "-c", "protocol.file.allow=never",
    `--git-dir=${input.sourceGitDir}`,
    "push",
    "--porcelain",
    "--no-verify",
    REPOSITORY,
    `${CANDIDATE_SHA}:refs/heads/${HEAD_BRANCH}`,
  ]);
  assert.equal(gitCalls[2].deadlineAt, input.deadlineAt);
  assert.equal(gitCalls[2].env.GIT_CONFIG_NOSYSTEM, "1");
  assert.equal(gitCalls[2].env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(gitCalls[2].env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(gitCalls[2].env.XDG_CONFIG_HOME, gitCalls[2].env.HOME);
  assert.equal(gitCalls[2].args.some(arg => arg.includes("force")), false);
  assert.equal(JSON.stringify(gitCalls.map(call => call.args)).includes(TOKEN), false);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
  assert.equal((await lstat(input.sourceGitDir)).isDirectory(), true);
});

test("askpass credentials are private, absent from argv, zeroed, deleted, and sanitized from errors", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  const capturedToken = path.join(path.dirname(askpassRoot), "captured-token");
  const gitCalls = [];
  const gitRunner = async options => {
    gitCalls.push(options);
    if (gitCalls.length === 1) {
      return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
    }

    const scriptStat = await lstat(options.env.GIT_ASKPASS);
    const tokenStat = await lstat(options.env.MONOLITH_GIT_TOKEN_FILE);
    const directoryStat = await lstat(path.dirname(options.env.GIT_ASKPASS));
    assert.equal(scriptStat.mode & 0o777, 0o700);
    assert.equal(tokenStat.mode & 0o777, 0o600);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    assert.equal((await readFile(options.env.GIT_ASKPASS, "utf8")).includes(TOKEN), false);
    assert.equal(await readFile(options.env.MONOLITH_GIT_TOKEN_FILE, "utf8"), `${TOKEN}\n`);
    await link(options.env.MONOLITH_GIT_TOKEN_FILE, capturedToken);
    throw new Error(`transport leaked ${TOKEN}`);
  };

  let failure;
  try {
    await publishRun(input, {
      askpassRoot,
      gitRunner,
      createGitHubPublisher: () => { throw new Error("must not reach GitHub"); },
    });
  } catch (error) {
    failure = error;
  }

  assert(failure instanceof Error);
  assert.equal(String(failure).includes(TOKEN), false);
  assert.match(failure.message, /transport leaked \[REDACTED\]/);
  assert.equal(JSON.stringify(gitCalls.map(call => call.args)).includes(TOKEN), false);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
  const zeroed = await readFile(capturedToken);
  assert.equal(zeroed.length, Buffer.byteLength(`${TOKEN}\n`));
  assert.equal(zeroed.every(byte => byte === 0), true);
});

test("an exact remote head creates one draft PR before recording and finishing the run", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  const timeline = [];
  const publisherConfigurations = [];
  const publishInputs = [];
  let gitCall = 0;
  const gitRunner = async () => {
    gitCall += 1;
    if (gitCall === 1) return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
    if (gitCall === 2) {
      return {
        code: 0,
        stdout: [
          `${BASE_SHA}\trefs/heads/${TARGET_BRANCH}`,
          `${CANDIDATE_SHA}\trefs/heads/${HEAD_BRANCH}`,
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    throw new Error("unexpected Git call");
  };
  const publication = {
    number: 42,
    url: "https://github.com/zaycruz/monolith-v2/pull/42",
    headBranch: HEAD_BRANCH,
    headSha: CANDIDATE_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
  };

  const result = await publishRun(input, {
    askpassRoot,
    gitRunner,
    createGitHubPublisher: configuration => {
      publisherConfigurations.push(configuration);
      return {
        publish: async publishInput => {
          timeline.push("pr");
          publishInputs.push(publishInput);
          return publication;
        },
      };
    },
    openRunStore: async options => {
      const real = await openPodRunStore(options);
      return {
        ...real,
        appendEvent: async (...args) => {
          timeline.push("event");
          return real.appendEvent(...args);
        },
        finish: async (...args) => {
          timeline.push("finish");
          return real.finish(...args);
        },
      };
    },
    removeSourceGitDir: async (target, options) => {
      timeline.push("cleanup");
      assert.equal(target, input.sourceGitDir);
      assert.deepEqual(options, { recursive: true, force: true });
      return rm(target, options);
    },
  });

  assert.deepEqual(timeline, ["pr", "event", "finish", "cleanup"]);
  assert.deepEqual(publisherConfigurations.map(({ repository, targetBranch, token }) => ({
    repository,
    targetBranch,
    token,
  })), [{ repository: REPOSITORY, targetBranch: TARGET_BRANCH, token: TOKEN }]);
  assert.deepEqual(publishInputs, [{
    headBranch: HEAD_BRANCH,
    headSha: CANDIDATE_SHA,
    baseSha: BASE_SHA,
    title: "Monolith run run-1",
    body: "Automated draft pull request for Monolith run run-1.",
    deadlineAt: input.deadlineAt,
    draft: true,
  }]);
  assert.deepEqual(result, {
    status: "completed",
    runId: "run-1",
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    headBranch: HEAD_BRANCH,
    publication,
  });

  const stored = await openPodRunStore({ stateRoot: input.stateRoot, runId: input.runId });
  assert.equal(stored.run.status, "completed");
  assert.equal(stored.run.phase, "published");
  assert.deepEqual(stored.run.publication, publication);
  assert.equal(stored.events.at(-2).type, "publication.finished");
  assert.deepEqual(stored.events.at(-2).publication, publication);
  assert.equal(stored.events.at(-1).type, "run.finished");
  assert.equal(JSON.stringify(stored).includes(TOKEN), false);
  assert.equal(await lstat(input.sourceGitDir).catch(() => null), null);
});

test("source cleanup failure cannot reverse a durably completed publication", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  let gitCall = 0;
  let cleanupCalls = 0;
  const publication = {
    number: 45,
    url: "https://github.com/zaycruz/monolith-v2/pull/45",
    headBranch: HEAD_BRANCH,
    headSha: CANDIDATE_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
  };

  const result = await publishRun(input, {
    askpassRoot,
    gitRunner: async () => {
      gitCall += 1;
      if (gitCall === 1) return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
      return {
        code: 0,
        stdout: [
          `${BASE_SHA}\trefs/heads/${TARGET_BRANCH}`,
          `${CANDIDATE_SHA}\trefs/heads/${HEAD_BRANCH}`,
          "",
        ].join("\n"),
        stderr: "",
      };
    },
    createGitHubPublisher: () => ({ publish: async () => publication }),
    removeSourceGitDir: async target => {
      cleanupCalls += 1;
      assert.equal(target, input.sourceGitDir);
      throw new Error(`cleanup failed with ${TOKEN}`);
    },
  });

  assert.equal(result.status, "completed");
  assert.equal(cleanupCalls, 1);
  assert.equal((await lstat(input.sourceGitDir)).isDirectory(), true);
  const stored = await openPodRunStore({ stateRoot: input.stateRoot, runId: input.runId });
  assert.equal(stored.run.status, "completed");
  assert.equal(JSON.stringify(stored).includes(TOKEN), false);
});

test("retrying an already completed publication returns its receipt with zero new side effects", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  let gitCalls = 0;
  let apiCalls = 0;
  const publication = {
    number: 43,
    url: "https://github.com/zaycruz/monolith-v2/pull/43",
    headBranch: HEAD_BRANCH,
    headSha: CANDIDATE_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
  };
  const first = await publishRun(input, {
    askpassRoot,
    gitRunner: async () => {
      gitCalls += 1;
      if (gitCalls === 1) return { code: 0, stdout: `${CANDIDATE_SHA}\n`, stderr: "" };
      return {
        code: 0,
        stdout: [
          `${BASE_SHA}\trefs/heads/${TARGET_BRANCH}`,
          `${CANDIDATE_SHA}\trefs/heads/${HEAD_BRANCH}`,
          "",
        ].join("\n"),
        stderr: "",
      };
    },
    createGitHubPublisher: () => ({
      publish: async () => {
        apiCalls += 1;
        return publication;
      },
    }),
  });
  assert.equal(gitCalls, 2);
  assert.equal(apiCalls, 1);

  const retry = await publishRun(input, {
    askpassRoot,
    gitRunner: async () => {
      throw new Error("retry must not call Git");
    },
    createGitHubPublisher: () => {
      throw new Error("retry must not construct a GitHub publisher");
    },
  });

  assert.deepEqual(retry, first);
  assert.equal(gitCalls, 2);
  assert.equal(apiCalls, 1);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
  assert.equal(await lstat(input.sourceGitDir).catch(() => null), null);
});

test("completed replay removes a crash-surviving source repo without Git or API calls", async (t) => {
  const { askpassRoot, input, publication } = await completedFixture(t);
  const before = await lstat(input.sourceGitDir);
  let cleanupCalls = 0;

  const result = await publishRun(input, {
    askpassRoot,
    gitRunner: async () => { throw new Error("completed replay must not call Git"); },
    createGitHubPublisher: () => { throw new Error("completed replay must not call GitHub"); },
    removeSourceGitDir: async (target, options) => {
      cleanupCalls += 1;
      const current = await lstat(target);
      assert.equal(current.dev, before.dev);
      assert.equal(current.ino, before.ino);
      await rm(target, options);
    },
  });

  assert.deepEqual(result, {
    status: "completed",
    runId: "run-1",
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    headBranch: HEAD_BRANCH,
    publication,
  });
  assert.equal(cleanupCalls, 1);
  assert.equal(await lstat(input.sourceGitDir).catch(() => null), null);
});

test("retry after the PR receipt was appended only finishes the run without repeating Git or API work", async (t) => {
  const { askpassRoot, input } = await fixture(t);
  const publication = {
    number: 44,
    url: "https://github.com/zaycruz/monolith-v2/pull/44",
    headBranch: HEAD_BRANCH,
    headSha: CANDIDATE_SHA,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    draft: true,
    created: true,
  };
  const interrupted = await openPodRunStore({ stateRoot: input.stateRoot, runId: input.runId });
  await interrupted.appendEvent("publication.finished", {
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    headBranch: HEAD_BRANCH,
    publication,
  });

  const result = await publishRun(input, {
    askpassRoot,
    gitRunner: async () => { throw new Error("must not repeat Git"); },
    createGitHubPublisher: () => { throw new Error("must not repeat GitHub"); },
  });

  assert.deepEqual(result, {
    status: "completed",
    runId: "run-1",
    repository: REPOSITORY,
    targetBranch: TARGET_BRANCH,
    baseSha: BASE_SHA,
    candidateSha: CANDIDATE_SHA,
    headBranch: HEAD_BRANCH,
    publication,
  });
  const stored = await openPodRunStore({ stateRoot: input.stateRoot, runId: input.runId });
  assert.equal(stored.run.status, "completed");
  assert.equal(stored.events.filter(event => event.type === "publication.finished").length, 1);
  assert.equal(await lstat(askpassRoot).catch(() => null), null);
  assert.equal(await lstat(input.sourceGitDir).catch(() => null), null);
});
