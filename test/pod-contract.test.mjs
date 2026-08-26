import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";

import {
  loadPodTemplate,
  validateAttemptPlan,
  validateCheckerReceipt,
  validateConformanceReceipt,
  validatePodTemplate,
  validateWriterReceipt,
} from "../src/pod-contract.mjs";

const root = path.resolve(import.meta.dirname, "..");
const RUN_BASE_SHA = "1".repeat(40);

function podTemplate() {
  return {
    version: 1,
    name: "parallel-engineering-pod",
    maxAttempts: 3,
    timeouts: {
      executionSeconds: 1_200,
      attemptSeconds: 3_600,
      workflowSeconds: 7_200,
    },
    changes: {
      maxFiles: 200,
      maxBytes: 5_242_880,
    },
    writers: {
      "engineering-a": {
        prompt: "roles/engineering.md",
        allowedWriteRoots: ["src"],
      },
      "engineering-b": {
        prompt: "roles/engineering.md",
        allowedWriteRoots: ["starters"],
      },
      "qa-tests": {
        prompt: "roles/qa-tests.md",
        allowedWriteRoots: ["test"],
      },
    },
    prompts: {
      planner: "roles/planner.md",
      checker: "roles/checker.md",
      qa: "roles/qa.md",
      testing: "roles/testing.md",
    },
    verificationProfile: "monolith-repo-v1",
  };
}

function attemptPlan() {
  return {
    version: 1,
    attempt: 1,
    baseSha: RUN_BASE_SHA,
    requirements: [
      { id: "REQ-CONTRACT", text: "Expose the fixed pod contract." },
      { id: "REQ-TEMPLATE", text: "Ship the fixed pod template." },
    ],
    acceptanceCriteria: [
      {
        id: "AC-CONTRACT",
        requirementIds: ["REQ-CONTRACT"],
        text: "The contract validates fixed writer plans.",
      },
      {
        id: "AC-TEMPLATE",
        requirementIds: ["REQ-TEMPLATE"],
        text: "The packaged template loads without executable fields.",
      },
    ],
    writers: {
      "engineering-a": {
        brief: "Implement the contract beneath src.",
        requirementIds: ["REQ-CONTRACT"],
        acceptanceIds: ["AC-CONTRACT"],
        writePaths: ["src"],
      },
      "engineering-b": {
        brief: "Implement the packaged template beneath starters/react.",
        requirementIds: ["REQ-TEMPLATE"],
        acceptanceIds: ["AC-TEMPLATE"],
        writePaths: ["starters/react"],
      },
      "qa-tests": {
        brief: "Add contract and template tests beneath test.",
        requirementIds: ["REQ-CONTRACT", "REQ-TEMPLATE"],
        acceptanceIds: ["AC-CONTRACT", "AC-TEMPLATE"],
        writePaths: ["test"],
      },
    },
  };
}

function writerReceipt(overrides = {}) {
  return {
    outcome: "completed",
    baseSha: RUN_BASE_SHA,
    what: "Implemented the fixed pod contract.",
    why: "Kept the topology explicit and data-only.",
    evidence: ["node --test test/pod-contract.test.mjs passed"],
    requirementIds: ["REQ-CONTRACT"],
    acceptanceIds: ["AC-CONTRACT"],
    inboxCursor: 0,
    dependencyRequest: null,
    ...overrides,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("pod templates expose one fixed data-only topology", () => {
  const template = podTemplate();
  assert.equal(validatePodTemplate(template), template);
  assert.deepEqual(Object.keys(template.writers), [
    "engineering-a",
    "engineering-b",
    "qa-tests",
  ]);

  assert.throws(
    () => validatePodTemplate({ ...template, executable: ["sh", "-c", "id"] }),
    /unknown pod template field: executable/,
  );

  const extraWriter = structuredClone(template);
  extraWriter.writers.manager = {
    prompt: "roles/planner.md",
    allowedWriteRoots: ["docs"],
  };
  assert.throws(() => validatePodTemplate(extraWriter), /exactly engineering-a, engineering-b, qa-tests/);

  assert.throws(
    () => validatePodTemplate({ ...template, verificationProfile: "planner-command" }),
    /unsupported verificationProfile: planner-command/,
  );
  assert.throws(
    () => validatePodTemplate({
      ...template,
      verificationProfile: { toString: () => { throw new Error("must not run"); } },
    }),
    /verificationProfile must be a string/,
  );
});

test("template-owned write roots are canonical, disjoint, and exclude control paths", () => {
  for (const forbidden of [
    ".git",
    ".git/objects",
    ".github",
    ".github/workflows",
    ".Git",
    "src/.git/objects",
    "src/.github/actions",
  ]) {
    const template = podTemplate();
    template.writers["engineering-a"].allowedWriteRoots = [forbidden];
    assert.throws(() => validatePodTemplate(template), /forbidden repository control path/);
  }

  for (const unsafe of [
    "../src",
    "/src",
    "src//feature",
    "src/./feature",
    "src\\feature",
  ]) {
    const template = podTemplate();
    template.writers["engineering-a"].allowedWriteRoots = [unsafe];
    assert.throws(() => validatePodTemplate(template), /canonical relative directory/);
  }

  for (const unsafe of ["src/space name", "src/café", `src/${"a".repeat(241)}`]) {
    const template = podTemplate();
    template.writers["engineering-a"].allowedWriteRoots = [unsafe];
    assert.throws(
      () => validatePodTemplate(template),
      /portable ASCII path no larger than 240 bytes/,
    );
  }

  const prefixOverlap = podTemplate();
  prefixOverlap.writers["engineering-b"].allowedWriteRoots = ["src/components"];
  assert.throws(() => validatePodTemplate(prefixOverlap), /write roots overlap/);

  const caseOverlap = podTemplate();
  caseOverlap.writers["engineering-b"].allowedWriteRoots = ["SRC"];
  assert.throws(() => validatePodTemplate(caseOverlap), /write roots overlap/);
});

test("the packaged pod loads all fixed prompts with a stable digest", async () => {
  const loaded = await loadPodTemplate("parallel-engineering-pod", {
    templateRoot: path.join(root, "templates"),
  });

  assert.equal(loaded.template.name, "parallel-engineering-pod");
  assert.deepEqual(Object.keys(loaded.template.writers), [
    "engineering-a",
    "engineering-b",
    "qa-tests",
  ]);
  assert.deepEqual(Object.keys(loaded.prompts).sort(), [
    "checker",
    "engineering-a",
    "engineering-b",
    "planner",
    "qa",
    "qa-tests",
    "testing",
  ]);
  assert.match(loaded.prompts.planner, /complete, immutable attempt plan/i);
  assert.match(loaded.prompts.checker, /delivered inbox slice/i);
  assert.match(loaded.prompts.qa, /read-only/i);
  assert.match(loaded.prompts.testing, /exact candidate SHA/i);
  assert.match(loaded.digest, /^[a-f0-9]{64}$/);
  assert.equal(loaded.templateDigest, loaded.digest);
});

test("packaged prompts state the strict handoff fields and deterministic authority", async () => {
  const loaded = await loadPodTemplate("parallel-engineering-pod", {
    templateRoot: path.join(root, "templates"),
  });

  assert.match(loaded.prompts.planner, /"acceptanceCriteria"/);
  assert.match(loaded.prompts.planner, /\/handoff\/result\.json/);
  assert.doesNotMatch(loaded.prompts.planner, /\/handoff\/plan\.json/);
  assert.match(loaded.prompts["engineering-a"], /"dependencyRequest"/);
  assert.match(loaded.prompts["engineering-a"], /"ownerBriefSha256"/);
  assert.match(loaded.prompts.checker, /"diffSha256"/);
  assert.match(loaded.prompts.checker, /"deliveredInbox"/);
  assert.match(loaded.prompts.qa, /"candidateSha"/);
  assert.match(loaded.prompts.testing, /monolith-repo-v1/);
  assert.match(loaded.prompts.testing, /semantic.*advisory/i);
});

test("an attempt is one complete fixed plan from the immutable run base", () => {
  const plan = attemptPlan();
  assert.equal(validateAttemptPlan(plan, {
    template: podTemplate(),
    runBaseSha: RUN_BASE_SHA,
    existingDirectories: ["src", "starters", "starters/react", "test"],
  }), plan);

  assert.throws(
    () => validateAttemptPlan({ ...plan, dependencies: [] }, {
      template: podTemplate(),
      runBaseSha: RUN_BASE_SHA,
      existingDirectories: ["src", "starters", "starters/react", "test"],
    }),
    /unknown attempt plan field: dependencies/,
  );

  const changedBase = { ...plan, baseSha: "2".repeat(40) };
  assert.throws(
    () => validateAttemptPlan(changedBase, {
      template: podTemplate(),
      runBaseSha: RUN_BASE_SHA,
      existingDirectories: ["src", "starters", "starters/react", "test"],
    }),
    /baseSha must equal the immutable run base/,
  );
});

test("planner writePaths only subdivide existing template-owned directories", () => {
  const context = {
    template: podTemplate(),
    runBaseSha: RUN_BASE_SHA,
    existingDirectories: ["src", "src/components", "starters", "starters/react", "test"],
  };

  const subdivided = attemptPlan();
  subdivided.writers["engineering-a"].writePaths = ["src/components"];
  assert.equal(validateAttemptPlan(subdivided, context), subdivided);

  const missing = attemptPlan();
  missing.writers["engineering-a"].writePaths = ["src/generated"];
  assert.throws(
    () => validateAttemptPlan(missing, context),
    /writePath is not an existing directory: src\/generated/,
  );

  const outside = attemptPlan();
  outside.writers["engineering-a"].writePaths = ["starters/react"];
  assert.throws(
    () => validateAttemptPlan(outside, context),
    /writePath is outside its template-owned root: starters\/react/,
  );

  const caseMismatch = attemptPlan();
  caseMismatch.writers["engineering-a"].writePaths = ["SRC/components"];
  assert.throws(
    () => validateAttemptPlan(caseMismatch, {
      ...context,
      existingDirectories: ["src", "SRC/components", "starters", "starters/react", "test"],
    }),
    /writePath is outside its template-owned root: SRC\/components/,
  );

  for (const unsafe of ["src/space name", "src/café"] ) {
    const plan = attemptPlan();
    plan.writers["engineering-a"].writePaths = [unsafe];
    assert.throws(
      () => validateAttemptPlan(plan, {
        ...context,
        existingDirectories: [...context.existingDirectories, unsafe],
      }),
      /portable ASCII path no larger than 240 bytes/,
    );
  }

  const overlapping = attemptPlan();
  overlapping.writers["engineering-a"].writePaths = ["src", "src/components"];
  assert.throws(
    () => validateAttemptPlan(overlapping, context),
    /attempt writePaths overlap/,
  );

  assert.throws(
    () => validateAttemptPlan(attemptPlan(), {
      ...context,
      existingDirectories: ["src", "SRC", "starters", "starters/react", "test"],
    }),
    /case-colliding directory: src and SRC/,
  );
});

test("attempt traceability has no orphan requirements or acceptance criteria", () => {
  const plan = attemptPlan();
  plan.requirements.push({ id: "REQ-ORPHAN", text: "This requirement has no acceptance criterion." });
  plan.writers["engineering-a"].requirementIds.push("REQ-ORPHAN");

  assert.throws(
    () => validateAttemptPlan(plan, {
      template: podTemplate(),
      runBaseSha: RUN_BASE_SHA,
      existingDirectories: ["src", "starters", "starters/react", "test"],
    }),
    /requirement has no acceptance criterion: REQ-ORPHAN/,
  );
});

test("writer receipts are strict and traced without claiming controller-owned deltas", () => {
  const context = {
    template: podTemplate(),
    plan: attemptPlan(),
    writerId: "engineering-a",
    executionBaseSha: RUN_BASE_SHA,
    deliveredInbox: [],
    previousInboxCursor: 0,
  };
  const receipt = writerReceipt();
  assert.equal(validateWriterReceipt(receipt, context), receipt);

  assert.throws(
    () => validateWriterReceipt({ ...receipt, surprise: true }, context),
    /unknown writer receipt field: surprise/,
  );
  assert.throws(
    () => validateWriterReceipt(writerReceipt({ files: ["src/pod-contract.mjs"] }), context),
    /unknown writer receipt field: files/,
  );
  assert.throws(
    () => validateWriterReceipt(writerReceipt({ changedBytes: 1 }), context),
    /unknown writer receipt field: changedBytes/,
  );
  assert.throws(
    () => validateWriterReceipt(writerReceipt({ requirementIds: ["REQ-TEMPLATE"] }), context),
    /requirementIds must exactly match the attempt plan/,
  );
});

test("blocked dependencies stay inside the existing owner brief, trace IDs, and writePaths", () => {
  const plan = attemptPlan();
  plan.writers["engineering-a"] = {
    brief: "Implement the contract against the packaged template owned by engineering-b.",
    requirementIds: ["REQ-CONTRACT", "REQ-TEMPLATE"],
    acceptanceIds: ["AC-CONTRACT", "AC-TEMPLATE"],
    writePaths: ["src"],
  };
  const owner = plan.writers["engineering-b"];
  const dependencyRequest = {
    owner: "engineering-b",
    path: "starters/react/vite.config.js",
    requirementIds: ["REQ-TEMPLATE"],
    acceptanceIds: ["AC-TEMPLATE"],
    ownerBriefSha256: sha256(owner.brief),
    need: "Expose the template configuration required by the contract.",
    why: "The contract cannot complete its assigned template acceptance criterion without it.",
  };
  const context = {
    template: podTemplate(),
    plan,
    writerId: "engineering-a",
    executionBaseSha: RUN_BASE_SHA,
    deliveredInbox: [],
    previousInboxCursor: 0,
  };
  const receipt = writerReceipt({
    outcome: "blocked",
    requirementIds: plan.writers["engineering-a"].requirementIds,
    acceptanceIds: plan.writers["engineering-a"].acceptanceIds,
    dependencyRequest,
  });
  assert.equal(validateWriterReceipt(receipt, context), receipt);

  assert.throws(
    () => validateWriterReceipt({
      ...receipt,
      dependencyRequest: { ...dependencyRequest, owner: "qa-tests" },
    }, context),
    /dependency owner must be the other Engineering slot/,
  );
  assert.throws(
    () => validateWriterReceipt({
      ...receipt,
      dependencyRequest: { ...dependencyRequest, path: "test/pod-contract.test.mjs" },
    }, context),
    /dependency path must be inside engineering-b writePaths/,
  );
  assert.throws(
    () => validateWriterReceipt({
      ...receipt,
      dependencyRequest: { ...dependencyRequest, path: "STARTERS/react/vite.config.js" },
    }, context),
    /dependency path must be inside engineering-b writePaths/,
  );
  assert.throws(
    () => validateWriterReceipt({
      ...receipt,
      dependencyRequest: { ...dependencyRequest, ownerBriefSha256: "0".repeat(64) },
    }, context),
    /dependency owner brief does not match the immutable attempt plan/,
  );

  const broadPlan = structuredClone(plan);
  broadPlan.writers["engineering-b"].requirementIds = ["REQ-CONTRACT", "REQ-TEMPLATE"];
  broadPlan.writers["engineering-b"].acceptanceIds = ["AC-CONTRACT", "AC-TEMPLATE"];
  const broadContext = { ...context, plan: broadPlan };
  assert.throws(
    () => validateWriterReceipt({
      ...receipt,
      dependencyRequest: {
        ...dependencyRequest,
        requirementIds: ["REQ-CONTRACT"],
        acceptanceIds: ["AC-TEMPLATE"],
        ownerBriefSha256: sha256(broadPlan.writers["engineering-b"].brief),
      },
    }, broadContext),
    /dependency acceptance AC-TEMPLATE requires REQ-TEMPLATE/,
  );
});

test("checker receipts bind the exact diff and delivered inbox slice", () => {
  const plan = attemptPlan();
  plan.writers["engineering-a"] = {
    brief: "Implement the contract against the packaged template owned by engineering-b.",
    requirementIds: ["REQ-CONTRACT", "REQ-TEMPLATE"],
    acceptanceIds: ["AC-CONTRACT", "AC-TEMPLATE"],
    writePaths: ["src"],
  };
  const owner = plan.writers["engineering-b"];
  const deliveredInbox = [{
    sequence: 1,
    requester: "engineering-a",
    owner: "engineering-b",
    path: "starters/react/vite.config.js",
    requirementIds: ["REQ-TEMPLATE"],
    acceptanceIds: ["AC-TEMPLATE"],
    ownerBriefSha256: sha256(owner.brief),
    need: "Expose the template configuration required by the contract.",
    why: "The contract cannot complete without the assigned template acceptance criterion.",
    requesterCheckpointSha: "5".repeat(40),
  }];
  const context = {
    plan,
    writerId: "engineering-b",
    baseSha: RUN_BASE_SHA,
    resultSha: "3".repeat(40),
    diffSha256: "4".repeat(64),
    deliveredInbox,
    previousInboxCursor: 0,
  };
  const receipt = {
    outcome: "passed",
    baseSha: context.baseSha,
    resultSha: context.resultSha,
    diffSha256: context.diffSha256,
    what: "The template change satisfies its assigned brief and dependency request.",
    why: "The exact diff is scoped, correct, and sufficiently evidenced.",
    evidence: ["Reviewed the exact base-to-result diff."],
    requirementIds: owner.requirementIds,
    acceptanceIds: owner.acceptanceIds,
    files: [],
    deliveredInbox,
  };
  assert.equal(validateCheckerReceipt(receipt, context), receipt);

  assert.throws(
    () => validateCheckerReceipt({
      ...receipt,
      deliveredInbox: [{ ...deliveredInbox[0], sequence: 2 }],
    }, context),
    /deliveredInbox must exactly match the controller-delivered slice/,
  );
  assert.throws(
    () => validateCheckerReceipt({ ...receipt, files: ["starters/react/vite.config.js"] }, context),
    /checker receipt files must be empty/,
  );
  assert.throws(
    () => validateCheckerReceipt({ ...receipt, resultSha: "6".repeat(40) }, context),
    /resultSha must equal the checked result/,
  );
});

test("QA and Testing receipts are read-only and bound to the exact candidate", () => {
  const plan = attemptPlan();
  const candidateSha = "7".repeat(40);
  const receipt = {
    gate: "qa",
    outcome: "passed",
    candidateSha,
    what: "The integrated candidate conforms to the complete plan.",
    why: "Every acceptance criterion is implemented without weakening tests.",
    evidence: ["Reviewed the exact integrated candidate and QA test commit."],
    requirementIds: plan.requirements.map(item => item.id),
    acceptanceIds: plan.acceptanceCriteria.map(item => item.id),
    files: [],
  };
  assert.equal(validateConformanceReceipt(receipt, { plan, gate: "qa", candidateSha }), receipt);

  const testing = {
    ...receipt,
    gate: "testing",
    evidence: ["Trusted unit, regression, and smoke gates passed."],
  };
  assert.equal(
    validateConformanceReceipt(testing, { plan, gate: "testing", candidateSha }),
    testing,
  );

  assert.throws(
    () => validateConformanceReceipt({ ...receipt, outcome: "failed" }, { plan, gate: "qa", candidateSha }),
    /QA outcome must be passed, test_defect, or product_nonconformance/,
  );
  assert.throws(
    () => validateConformanceReceipt({ ...testing, candidateSha: "8".repeat(40) }, {
      plan,
      gate: "testing",
      candidateSha,
    }),
    /candidateSha must equal the checked candidate/,
  );
  assert.throws(
    () => validateConformanceReceipt({ ...receipt, files: ["src/pod-contract.mjs"] }, {
      plan,
      gate: "qa",
      candidateSha,
    }),
    /conformance receipt files must be empty/,
  );
});
