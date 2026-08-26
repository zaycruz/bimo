import assert from "node:assert/strict";
import test from "node:test";
import {
  organize,
  runOrganizer,
  sha256,
  validateOrganizerReceipt,
  validateOrganizerPrompt,
  validateTemplateCatalog,
} from "../src/organize.mjs";

const CATALOG = [
  {
    template: "react-app",
    templateDigest: "a".repeat(64),
    acceptedOptions: ["--deployment", "--task-file"],
    kind: "workflow",
    roles: ["engineering", "qa", "testing"],
    maxSteps: 15,
  },
  {
    template: "react-solo",
    templateDigest: "b".repeat(64),
    acceptedOptions: ["--deployment", "--task-file"],
    kind: "workflow",
    roles: ["engineering"],
    maxSteps: 1,
  },
  {
    template: "react-pod",
    templateDigest: "c".repeat(64),
    acceptedOptions: ["--deployment", "--task-file"],
    kind: "engineering-pod",
    roles: ["planner", "engineering-a", "engineering-b", "qa-tests", "checker", "qa", "testing"],
    maxAttempts: 3,
  },
];
const PROMPT = "Build a small status page\nwith a readable health indicator.";

function receipt(template = "react-app", reason = "The app workflow matches the request.") {
  const entry = CATALOG.find(candidate => candidate.template === template);
  return {
    version: 1,
    template,
    templateDigest: entry.templateDigest,
    reason,
  };
}

function options(overrides = {}) {
  return {
    prompt: PROMPT,
    agents: 1,
    catalog: CATALOG,
    runAgent: async () => receipt(),
    ...overrides,
  };
}

test("validates the prompt boundary and computes its exact UTF-8 hash", () => {
  assert.equal(validateOrganizerPrompt(PROMPT), PROMPT);
  assert.equal(sha256(PROMPT), "fa26fcd15d8ecc633005e2f28decc7368f118821ec26673dab682cfb51fab95a");
  for (const prompt of ["", " \n\t ", "x\0y", "x\u0007y", "x\u000by", "x\u007fy"]) {
    assert.throws(() => validateOrganizerPrompt(prompt), /prompt/);
  }
  assert.throws(() => validateOrganizerPrompt("é".repeat(32_769)), /UTF-8/);
});

test("accepts newlines, carriage returns, and tabs but rejects invalid agent counts", async () => {
  assert.doesNotThrow(() => validateOrganizerPrompt("one\r\ntwo\tthree"));
  await Promise.all([0, 4, 1.5, true, "1", NaN].map(agents => (
    assert.rejects(organize(options({ agents })), /agents must be an integer/)
  )));
});

test("validates a digest-bound catalog and exact receipts", () => {
  assert.deepEqual(validateTemplateCatalog(CATALOG), CATALOG);
  assert.deepEqual(validateOrganizerReceipt(receipt(), CATALOG), {
    template: "react-app",
    templateDigest: "a".repeat(64),
    reason: "The app workflow matches the request.",
  });
  assert.throws(() => validateTemplateCatalog([{ ...CATALOG[0], template: "unknown template" }]), /invalid/);
  assert.throws(() => validateTemplateCatalog([CATALOG[0], CATALOG[0]]), /duplicate/);
  assert.throws(() => validateOrganizerReceipt({ ...receipt(), extra: true }, CATALOG), /exactly/);
  assert.throws(() => validateOrganizerReceipt({ version: 1 }, CATALOG), /exactly/);
  assert.throws(() => validateOrganizerReceipt({ ...receipt("react-solo"), templateDigest: "a".repeat(64) }, CATALOG), /mismatched/);
  assert.throws(() => validateOrganizerReceipt({ ...receipt(), template: "not-installed", templateDigest: "a".repeat(64) }, CATALOG), /unknown/);
  assert.throws(() => validateOrganizerReceipt({ ...receipt(), reason: "bad\u0007reason" }, CATALOG), /unsafe/);
});

test("runs exactly N agents concurrently with the same original prompt and catalog", async () => {
  const calls = [];
  let active = 0;
  let maximumActive = 0;
  const result = await organize(options({
    agents: 3,
    runAgent: async input => {
      calls.push(input);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise(resolve => setTimeout(resolve, 15));
      active -= 1;
      return receipt();
    },
  }));
  assert.equal(calls.length, 3);
  assert.equal(maximumActive, 3);
  assert.ok(calls.every(call => call.prompt === PROMPT));
  assert.ok(calls.every(call => call.catalog === calls[0].catalog));
  assert.deepEqual(calls[0].catalog, CATALOG);
  assert.deepEqual(result.votes.map(vote => vote.template), ["react-app", "react-app", "react-app"]);
  assert.equal(result.agents, 3);
});

test("keeps deterministic invocation order when agents resolve out of order", async () => {
  const calls = [];
  const result = await organize(options({
    agents: 3,
    runAgent: async input => {
      const index = calls.push(input) - 1;
      await new Promise(resolve => setTimeout(resolve, (2 - index) * 5));
      return receipt("react-app", `reason-${index}`);
    },
  }));
  assert.deepEqual(result.votes.map(vote => vote.reason), ["reason-0", "reason-1", "reason-2"]);
});

test("applies N=1 selection, N=2 unanimity, and N=3 majority", async () => {
  assert.equal((await organize(options())).template, "react-app");
  let unanimousIndex = 0;
  assert.equal((await organize(options({
    agents: 2,
    runAgent: async () => receipt(unanimousIndex++ === 0 ? "react-app" : "react-app"),
  }))).status, "planned");
  let splitIndex = 0;
  await assert.rejects(organize(options({
    agents: 2,
    runAgent: async () => receipt(splitIndex++ === 0 ? "react-app" : "react-solo"),
  })), /unanimous/);
  const majority = await organize(options({
    agents: 3,
    runAgent: (() => {
      let index = 0;
      return async () => receipt(index++ === 2 ? "react-solo" : "react-app");
    })(),
  }));
  assert.equal(majority.template, "react-app");
  await assert.rejects(organize(options({
    agents: 3,
    runAgent: (() => {
      let index = 0;
      return async () => receipt(["react-app", "react-solo", "react-pod"][index++]);
    })(),
  })), /majority/);
});

test("fails closed on rejected, timed-out, malformed, and mismatched agent results", async () => {
  const rejectedCalls = [];
  await assert.rejects(organize(options({
    agents: 3,
    runAgent: async input => {
      rejectedCalls.push(input);
      if (rejectedCalls.length === 1) throw new Error("provider rejected");
      return receipt();
    },
  })), /provider rejected/);
  assert.equal(rejectedCalls.length, 3);

  let aborted = 0;
  await assert.rejects(organize(options({
    agents: 3,
    timeoutMs: 5,
    runAgent: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted += 1;
        reject(signal.reason);
      }, { once: true });
    }),
  })), /timed out/);
  assert.equal(aborted, 3);
  await assert.rejects(organize(options({ runAgent: async () => ({ ...receipt(), extra: "nope" }) })), /exactly/);
  await assert.rejects(organize(options({ runAgent: async () => ({ ...receipt(), templateDigest: "c".repeat(64) }) })), /mismatched/);
  await assert.rejects(organize(options({ runAgent: async () => ({ ...receipt(), template: "missing" }) })), /unknown/);
});

test("returns only safe JSON-ready planning data and a non-executable handoff", async () => {
  const result = await organize(options({
    runAgent: async () => receipt("react-app", "Use the installed app template.\nNo commands are implied."),
  }));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  assert.equal(result.version, 1);
  assert.equal(result.status, "planned");
  assert.equal(result.promptSha256, sha256(PROMPT));
  assert.deepEqual(result.handoff, {
    template: "react-app",
    templateDigest: "a".repeat(64),
    acceptedOptions: ["--deployment", "--task-file"],
  });
  assert.doesNotMatch(JSON.stringify(result.handoff), /shell|command|argv/iu);
  assert.equal(Object.hasOwn(result.handoff, "command"), false);
  assert.equal(Object.hasOwn(result.handoff, "argv"), false);
  assert.equal(Object.hasOwn(result.handoff, "host"), false);
  assert.equal(Object.hasOwn(result.handoff, "secret"), false);
});

test("runOrganizer supplies one identical composed prompt and accepts receipt envelopes", async () => {
  const calls = [];
  const result = await runOrganizer({
    prompt: PROMPT,
    agents: 2,
    baseInstructions: "You are a bounded planner.",
    catalog: [{
      template: "react-app",
      templateDigest: "a".repeat(64),
      acceptedOptions: ["--deployment", "--host", "--secret-ref"],
      kind: "workflow",
      roles: ["engineering", "qa"],
      maxSteps: 15,
    }],
    runAgent: async input => {
      calls.push(input);
      return { receipt: receipt() };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, calls[1].prompt);
  assert.match(calls[0].prompt, /Original assignment/);
  assert.match(calls[0].prompt, /"kind":"workflow"/);
  assert.match(calls[0].prompt, /"roles":\["engineering","qa"\]/);
  assert.match(calls[0].prompt, /Write only .*\/handoff\/result\.json/);
  assert.deepEqual(result.handoff, {
    template: "react-app",
    templateDigest: "a".repeat(64),
    acceptedOptions: ["--deployment", "--host", "--secret-ref"],
  });
});
