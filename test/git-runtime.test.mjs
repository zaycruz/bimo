import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  link,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { GitRuntime } from "../src/git-runtime.mjs";
import { scanSourceSnapshot } from "../src/source-verify.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY = "https://github.com/zaycruz/monolith-v2.git";

async function git(cwd, args) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout.trim();
}

function gitRunnerWithHook(hook) {
  return async (command, args, options = {}) => {
    await hook({ command, args, ...options });
    return new Promise((resolve, reject) => {
      const child = execFile(command, args, {
        cwd: options.cwd,
        env: options.env,
        encoding: null,
        maxBuffer: options.maxOutputBytes ?? 4 * 1024 * 1024,
        signal: options.signal,
      }, (error, stdout, stderr) => {
        if (error && !Number.isInteger(error.code)) {
          reject(error);
          return;
        }
        resolve({
          stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? ""),
          stderr: Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? ""),
          exitCode: Number.isInteger(error?.code) ? error.code : 0,
        });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    });
  };
}

async function repositoryFixture(t, { externalSymlink } = {}) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monolith-git-runtime-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, "source");
  const remote = path.join(temporary, "remote.git");
  await mkdir(path.join(source, "src"), { recursive: true });
  await mkdir(path.join(source, "templates"));
  await mkdir(path.join(source, "test"));
  await mkdir(path.join(source, ".github", "workflows"), { recursive: true });
  await writeFile(path.join(source, "src", "app.mjs"), "export const app = 'base';\n");
  await writeFile(path.join(source, "src", "delete-me.txt"), "delete me\n");
  await writeFile(path.join(source, "templates", "page.html"), "<h1>Base</h1>\n");
  await writeFile(path.join(source, "test", "app.test.mjs"), "// base test\n");
  await writeFile(path.join(source, ".github", "workflows", "ci.yml"), "name: CI\n");
  await writeFile(path.join(source, ".gitignore"), "src/ignored.txt\n");
  if (externalSymlink !== undefined) {
    await symlink(externalSymlink, path.join(source, "external-link"));
  }
  await git(source, ["init", "--initial-branch=main"]);
  await git(source, ["config", "user.name", "Fixture"]);
  await git(source, ["config", "user.email", "fixture@example.invalid"]);
  await git(source, ["add", "-A"]);
  await git(source, ["commit", "-m", "base"]);
  const baseSha = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["checkout", "-b", "other"]);
  await writeFile(path.join(source, "src", "other.mjs"), "export const other = true;\n");
  await git(source, ["add", "-A"]);
  await git(source, ["commit", "-m", "other branch"]);
  const otherSha = await git(source, ["rev-parse", "HEAD"]);
  await git(source, ["checkout", "main"]);
  await git(temporary, ["clone", "--bare", source, remote]);
  return {
    temporary,
    remote: pathToFileURL(remote).href,
    baseSha,
    otherSha,
  };
}

function runtimeFor(fixture, overrides = {}) {
  return new GitRuntime({
    allowedRepositories: [REPOSITORY],
    cloneSource: fixture.remote,
    allowLocalRepository: true,
    gitRoot: path.join(fixture.temporary, "controller"),
    snapshotsRoot: path.join(fixture.temporary, "snapshots"),
    worktreesRoot: path.join(fixture.temporary, "worktrees"),
    runId: "run-1",
    allowedWriteRoots: {
      "engineering-a": ["src"],
      "engineering-b": ["templates"],
      "qa-tests": ["test"],
    },
    ...overrides,
  });
}

function futureDeadline(milliseconds = 60_000) {
  return Date.now() + milliseconds;
}

function workItem(ownerSlot, writePaths) {
  return {
    id: `WORK-${ownerSlot.toUpperCase()}`,
    ownerSlot,
    writePaths,
  };
}

async function prepare(runtime, fixture) {
  return runtime.prepareAssignment({
    repository: REPOSITORY,
    baseRevision: fixture.baseSha,
    targetBranch: "main",
    deadlineAt: futureDeadline(),
  });
}

async function writer(runtime, fixture, {
  attempt = 1,
  ownerSlot = "engineering-a",
  writePaths = ["src"],
} = {}) {
  return runtime.createWorktree({
    attempt,
    workItem: workItem(ownerSlot, writePaths),
    baseSha: fixture.baseSha,
    deadlineAt: futureDeadline(),
  });
}

async function checkpoint(runtime, workspace, ownerSlot, limits = {}) {
  return runtime.validateAndCommit({
    workspace,
    workItem: workItem(ownerSlot, workspace.writeDirectories),
    limits: {
      maxFiles: 20,
      maxBytes: 128 * 1024,
      ...limits,
    },
    deadlineAt: futureDeadline(),
  });
}

test("prepares only an allowlisted GitHub repository at an exact SHA-1 base", async (t) => {
  const fixture = await repositoryFixture(t);
  const runtime = runtimeFor(fixture);

  await assert.rejects(runtime.prepareAssignment({
    repository: "https://github.com/attacker/other.git",
    baseRevision: fixture.baseSha,
    targetBranch: "main",
    deadlineAt: futureDeadline(),
  }), /repository is not allowlisted/);

  const mismatch = runtimeFor(fixture, {
    gitRoot: path.join(fixture.temporary, "controller-mismatch"),
    snapshotsRoot: path.join(fixture.temporary, "snapshots-mismatch"),
    worktreesRoot: path.join(fixture.temporary, "worktrees-mismatch"),
    runId: "run-mismatch",
  });
  await assert.rejects(mismatch.prepareAssignment({
    repository: REPOSITORY,
    baseRevision: fixture.otherSha,
    targetBranch: "main",
    deadlineAt: futureDeadline(),
  }), /freshly cloned target branch head/);
  await mismatch.close({ deadlineAt: futureDeadline() });

  const prepared = await runtime.prepareAssignment({
    repository: REPOSITORY,
    baseRevision: fixture.baseSha,
    targetBranch: "main",
    deadlineAt: futureDeadline(),
  });

  assert.equal(prepared.baseSha, fixture.baseSha);
  assert.equal(prepared.objectFormat, "sha1");
  assert.equal((await lstat(path.join(fixture.temporary, "controller", "repository.git"))).mode & 0o777, 0o700);
  assert.deepEqual(prepared.existingDirectories, ["src", "templates", "test"]);
  await runtime.close({ deadlineAt: futureDeadline() });
  await assert.rejects(lstat(path.join(fixture.temporary, "controller", "repository.git")), /ENOENT/);
  assert.deepEqual(await readdir(path.join(fixture.temporary, "controller")), []);
});

test("creates each writer from the immutable run base with only validated writable directories", async (t) => {
  const fixture = await repositoryFixture(t);
  const runtime = runtimeFor(fixture);
  await prepare(runtime, fixture);

  const first = await writer(runtime, fixture);
  assert.deepEqual(Object.keys(first).sort(), ["id", "root", "writeDirectories"]);
  assert.deepEqual(first.writeDirectories, ["src"]);
  assert.equal(await readFile(path.join(first.root, "src", "app.mjs"), "utf8"), "export const app = 'base';\n");

  const rootFile = await lstat(path.join(first.root, ".gitignore"));
  const gitPointer = await lstat(path.join(first.root, ".git"));
  const ownedDirectory = await lstat(path.join(first.root, "src"));
  assert.equal(rootFile.mode & 0o022, 0, "unowned files are not group/other writable");
  assert.equal(gitPointer.mode & 0o777, 0o400, "linked-worktree metadata is controller-only");
  assert.notEqual(ownedDirectory.mode & 0o200, 0, "owned directory is writable by its owner");

  await writeFile(path.join(first.root, "src", "app.mjs"), "export const app = 'attempt one';\n");
  const second = await writer(runtime, fixture, { attempt: 2 });
  assert.equal(await readFile(path.join(second.root, "src", "app.mjs"), "utf8"), "export const app = 'base';\n");

  await assert.rejects(writer(runtime, fixture, {
    attempt: 3,
    writePaths: ["templates"],
  }), /outside the allowed write roots/);
  await assert.rejects(writer(runtime, fixture, {
    attempt: 3,
    writePaths: [".GitHub"],
  }), /forbidden repository control path/);
  await assert.rejects(writer(runtime, fixture, {
    attempt: 3,
    writePaths: ["src/missing"],
  }), /existing directory/);

  await runtime.close({ deadlineAt: futureDeadline() });
});

test("inspects tracked, ignored, untracked, and deleted files and rejects unsafe deltas before staging", async (t) => {
  const fixture = await repositoryFixture(t);
  const runtime = runtimeFor(fixture);
  await prepare(runtime, fixture);

  const workspace = await writer(runtime, fixture);
  await writeFile(path.join(workspace.root, "src", "app.mjs"), "export const app = 'changed';\n");
  await unlink(path.join(workspace.root, "src", "delete-me.txt"));
  await writeFile(path.join(workspace.root, "src", "new.txt"), "new\n");
  await writeFile(path.join(workspace.root, "src", "ignored.txt"), "ignored but authoritative\n");

  const inspected = await runtime.inspect({
    workspace,
    limits: { maxFiles: 10, maxBytes: 10_000 },
    deadlineAt: futureDeadline(),
  });
  assert.deepEqual(inspected.changes.map(change => [change.status, change.path]), [
    ["M", "src/app.mjs"],
    ["D", "src/delete-me.txt"],
    ["A", "src/ignored.txt"],
    ["A", "src/new.txt"],
  ]);
  assert.equal(inspected.changedFiles, 4);
  assert.ok(inspected.changedBytes > 0);

  await assert.rejects(runtime.inspect({
    workspace,
    limits: { maxFiles: 3, maxBytes: 10_000 },
    deadlineAt: futureDeadline(),
  }), /changed-file limit/);
  await assert.rejects(runtime.inspect({
    workspace,
    limits: { maxChangedFiles: 10, maxChangedBytes: 10_000 },
    deadlineAt: futureDeadline(),
  }), /exactly maxFiles and maxBytes/);

  const outside = await writer(runtime, fixture, { attempt: 2 });
  await chmod(path.join(outside.root, "templates"), 0o755);
  await chmod(path.join(outside.root, "templates", "page.html"), 0o644);
  await writeFile(path.join(outside.root, "templates", "page.html"), "outside\n");
  await assert.rejects(runtime.inspect({
    workspace: outside,
    limits: { maxFiles: 10, maxBytes: 10_000 },
    deadlineAt: futureDeadline(),
  }), /outside the writer scope/);

  const unsafe = await writer(runtime, fixture, { attempt: 3 });
  await symlink("../templates/page.html", path.join(unsafe.root, "src", "escape"));
  await assert.rejects(runtime.inspect({
    workspace: unsafe,
    limits: { maxFiles: 10, maxBytes: 10_000 },
    deadlineAt: futureDeadline(),
  }), /symbolic link/);

  const hardlinked = await writer(runtime, fixture, { attempt: 4 });
  await link(path.join(hardlinked.root, ".gitignore"), path.join(hardlinked.root, "src", "hardlink"));
  await assert.rejects(runtime.inspect({
    workspace: hardlinked,
    limits: { maxFiles: 10, maxBytes: 10_000 },
    deadlineAt: futureDeadline(),
  }), /hard-linked file/);

  const controlPath = await writer(runtime, fixture, { attempt: 5 });
  await chmod(path.join(controlPath.root, ".github"), 0o755);
  await chmod(path.join(controlPath.root, ".github", "workflows"), 0o755);
  await chmod(path.join(controlPath.root, ".github", "workflows", "ci.yml"), 0o644);
  await writeFile(path.join(controlPath.root, ".github", "workflows", "ci.yml"), "name: attacker\n");
  await assert.rejects(runtime.inspect({
    workspace: controlPath,
    limits: { maxFiles: 10, maxBytes: 10_000 },
    deadlineAt: futureDeadline(),
  }), /forbidden repository control path/);

  await runtime.close({ deadlineAt: futureDeadline() });
});

test("authors the checkpoint commit itself with an exact bounded diff and disabled hooks", async (t) => {
  const fixture = await repositoryFixture(t);
  const runtime = runtimeFor(fixture);
  await prepare(runtime, fixture);
  const workspace = await writer(runtime, fixture);
  await writeFile(path.join(workspace.root, "src", "app.mjs"), "export const app = 'checkpoint';\n");
  await writeFile(path.join(workspace.root, "src", "new.txt"), "new file\n");

  const gitDirectory = await git(workspace.root, ["rev-parse", "--git-common-dir"]);
  const hookMarker = path.join(fixture.temporary, "hook-ran");
  await mkdir(path.join(gitDirectory, "hooks"), { recursive: true });
  await writeFile(path.join(gitDirectory, "hooks", "pre-commit"), `#!/bin/sh\ntouch ${JSON.stringify(hookMarker)}\n`);
  await chmod(path.join(gitDirectory, "hooks", "pre-commit"), 0o755);

  const committed = await checkpoint(runtime, workspace, "engineering-a");
  assert.equal(committed.baseSha, fixture.baseSha);
  assert.match(committed.resultSha, /^[a-f0-9]{40}$/);
  assert.deepEqual(committed.changedPaths, ["src/app.mjs", "src/new.txt"]);
  assert.equal(committed.diffSha256, createHash("sha256").update(committed.diff).digest("hex"));
  assert.equal(await git(workspace.root, ["show", "-s", "--format=%an <%ae>", "HEAD"]), "Monolith Controller <controller@thisismonolith.invalid>");
  await assert.rejects(lstat(hookMarker), /ENOENT/);

  const reread = await runtime.readCommit({
    baseSha: fixture.baseSha,
    resultSha: committed.resultSha,
    deadlineAt: futureDeadline(),
  });
  assert.equal(reread.diff, committed.diff);
  assert.equal(reread.diffSha256, committed.diffSha256);
  await runtime.close({ deadlineAt: futureDeadline() });
});

test("combines only same-attempt dependency results and integrates the fixed slots in deterministic order", async (t) => {
  const fixture = await repositoryFixture(t);
  let controllerResets = 0;
  const runtime = runtimeFor(fixture, {
    runner: gitRunnerWithHook(async ({ args }) => {
      const workTree = args.find(argument => argument.startsWith("--work-tree="))?.slice("--work-tree=".length);
      const controllerMaterialization = workTree?.includes("-integration-")
        || workTree?.includes("-engineering-a-resume-");
      if (!controllerMaterialization || !args.includes("reset") || !args.includes("--hard")) return;
      for (const directory of [workTree, path.join(workTree, ".github", "workflows")]) {
        assert.notEqual((await lstat(directory)).mode & 0o200, 0, `${directory} must be controller-writable before reset`);
      }
      await Promise.all([
        unlink(path.join(workTree, ".gitignore")),
        unlink(path.join(workTree, ".github", "workflows", "ci.yml")),
      ]);
      controllerResets += 1;
    }),
  });
  await prepare(runtime, fixture);

  const engineeringA = await writer(runtime, fixture, { ownerSlot: "engineering-a" });
  await writeFile(path.join(engineeringA.root, "src", "app.mjs"), "export const app = 'requester checkpoint';\n");
  const requesterCheckpoint = await checkpoint(runtime, engineeringA, "engineering-a");

  const engineeringB = await writer(runtime, fixture, {
    ownerSlot: "engineering-b",
    writePaths: ["templates"],
  });
  await writeFile(path.join(engineeringB.root, "templates", "page.html"), "<h1>Dependency</h1>\n");
  const dependencyResult = await checkpoint(runtime, engineeringB, "engineering-b");

  const qa = await writer(runtime, fixture, {
    ownerSlot: "qa-tests",
    writePaths: ["test"],
  });
  await writeFile(path.join(qa.root, "test", "app.test.mjs"), "// exact candidate test\n");
  const qaResult = await checkpoint(runtime, qa, "qa-tests");

  const combined = await runtime.combineBase({
    attempt: 1,
    requesterCheckpointSha: requesterCheckpoint.resultSha,
    dependencyResultSha: dependencyResult.resultSha,
    deadlineAt: futureDeadline(),
  });
  assert.match(combined.baseSha, /^[a-f0-9]{40}$/);
  assert.equal(await readFile(path.join(combined.workspace.root, "src", "app.mjs"), "utf8"), "export const app = 'requester checkpoint';\n");
  assert.equal(await readFile(path.join(combined.workspace.root, "templates", "page.html"), "utf8"), "<h1>Dependency</h1>\n");
  assert.equal(await readFile(path.join(combined.workspace.root, ".gitignore"), "utf8"), "src/ignored.txt\n");
  assert.equal(await readFile(path.join(combined.workspace.root, ".github", "workflows", "ci.yml"), "utf8"), "name: CI\n");
  assert.equal((await lstat(combined.workspace.root)).mode & 0o777, 0o555);
  assert.equal((await lstat(path.join(combined.workspace.root, ".github", "workflows"))).mode & 0o777, 0o555);
  assert.equal((await lstat(path.join(combined.workspace.root, ".git"))).mode & 0o777, 0o400);
  assert.equal((await lstat(path.join(combined.workspace.root, ".gitignore"))).mode & 0o777, 0o444);

  await writeFile(path.join(combined.workspace.root, "src", "app.mjs"), "export const app = 'resumed';\n");
  const requesterResult = await checkpoint(runtime, combined.workspace, "engineering-a");

  const integrated = await runtime.integrate({
    attempt: 1,
    baseSha: fixture.baseSha,
    commits: [qaResult, dependencyResult, requesterResult],
    integrationOrder: ["engineering-a", "engineering-b", "qa-tests"],
    branch: "monolith/run-1",
    deadlineAt: futureDeadline(),
  });
  assert.match(integrated.candidateSha, /^[a-f0-9]{40}$/);
  assert.deepEqual(integrated.integratedResultShas, [
    requesterResult.resultSha,
    dependencyResult.resultSha,
    qaResult.resultSha,
  ]);
  assert.deepEqual((await git(integrated.workspaceRoot, [
    "show", "-s", "--format=%P", integrated.candidateSha,
  ])).split(" "), integrated.integratedResultShas);
  for (const resultSha of integrated.integratedResultShas) {
    await git(integrated.workspaceRoot, ["merge-base", "--is-ancestor", resultSha, integrated.candidateSha]);
  }
  assert.equal(await git(integrated.workspaceRoot, ["rev-parse", "HEAD"]), integrated.candidateSha);
  assert.equal(await readFile(path.join(integrated.workspaceRoot, "src", "app.mjs"), "utf8"), "export const app = 'resumed';\n");
  assert.equal(await readFile(path.join(integrated.workspaceRoot, "templates", "page.html"), "utf8"), "<h1>Dependency</h1>\n");
  assert.equal(await readFile(path.join(integrated.workspaceRoot, "test", "app.test.mjs"), "utf8"), "// exact candidate test\n");
  assert.equal(await readFile(path.join(integrated.workspaceRoot, ".gitignore"), "utf8"), "src/ignored.txt\n");
  assert.equal(await readFile(path.join(integrated.workspaceRoot, ".github", "workflows", "ci.yml"), "utf8"), "name: CI\n");
  assert.equal((await lstat(integrated.workspaceRoot)).mode & 0o777, 0o555);
  assert.equal((await lstat(path.join(integrated.workspaceRoot, ".github", "workflows"))).mode & 0o777, 0o555);
  assert.equal((await lstat(path.join(integrated.workspaceRoot, ".git"))).mode & 0o777, 0o400);
  assert.equal((await lstat(path.join(integrated.workspaceRoot, ".gitignore"))).mode & 0o777, 0o444);
  assert.equal((await lstat(path.join(integrated.workspaceRoot, ".github", "workflows", "ci.yml"))).mode & 0o777, 0o444);

  const repeated = await runtime.integrate({
    attempt: 1,
    baseSha: fixture.baseSha,
    commits: [requesterResult, dependencyResult, qaResult],
    integrationOrder: ["engineering-a", "engineering-b", "qa-tests"],
    branch: "monolith/run-1-repeat",
    deadlineAt: futureDeadline(),
  });
  assert.equal(repeated.candidateSha, integrated.candidateSha, "integration is deterministic for exact accepted commits");
  assert.equal(controllerResets, 4);

  const scan = await runtime.scan({
    baseSha: fixture.baseSha,
    candidateSha: integrated.candidateSha,
    deadlineAt: futureDeadline(),
  });
  assert.equal(scan.status, "passed");
  assert.equal(scan.candidateSha, integrated.candidateSha);

  const baseSnapshot = await runtime.createSnapshot({
    id: "base",
    sha: fixture.baseSha,
    deadlineAt: futureDeadline(),
  });
  const candidateSnapshot = await runtime.createSnapshot({
    id: "candidate",
    sha: integrated.candidateSha,
    deadlineAt: futureDeadline(),
  });
  assert.deepEqual(Object.keys(candidateSnapshot).sort(), ["id", "receipt", "root", "sha"]);
  assert.deepEqual(candidateSnapshot.receipt, await scanSourceSnapshot(candidateSnapshot.root));
  assert.deepEqual(baseSnapshot.receipt, await scanSourceSnapshot(baseSnapshot.root));
  assert.notEqual(candidateSnapshot.receipt.sha256, baseSnapshot.receipt.sha256);
  await assert.rejects(lstat(path.join(candidateSnapshot.root, ".git")), /ENOENT/);
  assert.equal((await lstat(candidateSnapshot.root)).mode & 0o222, 0);
  assert.equal((await lstat(path.join(candidateSnapshot.root, "src", "app.mjs"))).mode & 0o222, 0);

  const attemptTwo = await writer(runtime, fixture, { attempt: 2 });
  await writeFile(path.join(attemptTwo.root, "src", "app.mjs"), "export const app = 'attempt two';\n");
  const attemptTwoResult = await checkpoint(runtime, attemptTwo, "engineering-a");
  await assert.rejects(runtime.combineBase({
    attempt: 2,
    requesterCheckpointSha: attemptTwoResult.resultSha,
    dependencyResultSha: dependencyResult.resultSha,
    deadlineAt: futureDeadline(),
  }), /same attempt/);
  await assert.rejects(runtime.integrate({
    attempt: 1,
    baseSha: fixture.baseSha,
    commits: [requesterResult, dependencyResult, qaResult],
    integrationOrder: ["engineering-b", "engineering-a", "qa-tests"],
    branch: "monolith/run-1-wrong",
    deadlineAt: futureDeadline(),
  }), /fixed integration order/);

  await runtime.close({ retainForPublication: true, deadlineAt: futureDeadline() });
  await assert.rejects(lstat(path.join(fixture.temporary, "worktrees", "run-1")), /ENOENT/);
  await assert.rejects(lstat(path.join(fixture.temporary, "snapshots", "run-1")), /ENOENT/);
  assert.equal((await lstat(path.join(fixture.temporary, "controller", "repository.git"))).isDirectory(), true);
});

test("rejects a checkout symlink before permissions can touch its external target", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monolith-git-external-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const external = path.join(temporary, "external.txt");
  await writeFile(external, "must remain unchanged\n", { mode: 0o600 });
  const before = await lstat(external);
  const fixture = await repositoryFixture(t, { externalSymlink: external });
  const runtime = runtimeFor(fixture);
  await prepare(runtime, fixture);

  await assert.rejects(writer(runtime, fixture), /symbolic link in the worktree/);
  const after = await lstat(external);
  assert.equal(after.mode & 0o777, before.mode & 0o777);
  assert.equal(await readFile(external, "utf8"), "must remain unchanged\n");
  await runtime.close({ deadlineAt: futureDeadline() });
});

test("pre-publication scan rejects likely live secrets and executable policy surprises", async (t) => {
  const fixture = await repositoryFixture(t);
  const runtime = runtimeFor(fixture);
  await prepare(runtime, fixture);

  const integrateAttempt = async ({ attempt, mutateEngineeringA }) => {
    const a = await writer(runtime, fixture, { attempt, ownerSlot: "engineering-a" });
    await mutateEngineeringA(a.root);
    const aResult = await checkpoint(runtime, a, "engineering-a");
    const b = await writer(runtime, fixture, {
      attempt,
      ownerSlot: "engineering-b",
      writePaths: ["templates"],
    });
    await writeFile(path.join(b.root, "templates", "page.html"), `<h1>attempt ${attempt}</h1>\n`);
    const bResult = await checkpoint(runtime, b, "engineering-b");
    const qa = await writer(runtime, fixture, {
      attempt,
      ownerSlot: "qa-tests",
      writePaths: ["test"],
    });
    await writeFile(path.join(qa.root, "test", "app.test.mjs"), `// attempt ${attempt}\n`);
    const qaResult = await checkpoint(runtime, qa, "qa-tests");
    return runtime.integrate({
      attempt,
      baseSha: fixture.baseSha,
      commits: [aResult, bResult, qaResult],
      integrationOrder: ["engineering-a", "engineering-b", "qa-tests"],
      branch: `monolith/scan-${attempt}`,
      deadlineAt: futureDeadline(),
    });
  };

  const secretCandidate = await integrateAttempt({
    attempt: 1,
    mutateEngineeringA: root => writeFile(
      path.join(root, "src", "private.txt"),
      `github_pat_${"a".repeat(82)}\n`,
    ),
  });
  await assert.rejects(runtime.scan({
    baseSha: fixture.baseSha,
    candidateSha: secretCandidate.candidateSha,
    deadlineAt: futureDeadline(),
  }), /likely live secret or private key/);

  const executableCandidate = await integrateAttempt({
    attempt: 2,
    mutateEngineeringA: root => chmod(path.join(root, "src", "app.mjs"), 0o755),
  });
  await assert.rejects(runtime.scan({
    baseSha: fixture.baseSha,
    candidateSha: executableCandidate.candidateSha,
    deadlineAt: futureDeadline(),
  }), /executable/);

  const checkpointWriter = await writer(runtime, fixture, {
    attempt: 3,
    ownerSlot: "engineering-a",
  });
  const transientSecret = path.join(checkpointWriter.root, "src", "transient-secret.txt");
  await writeFile(transientSecret, `github_pat_${"b".repeat(82)}\n`);
  const secretCheckpoint = await checkpoint(runtime, checkpointWriter, "engineering-a");
  const dependency = await writer(runtime, fixture, {
    attempt: 3,
    ownerSlot: "engineering-b",
    writePaths: ["templates"],
  });
  await writeFile(path.join(dependency.root, "templates", "page.html"), "<h1>history dependency</h1>\n");
  const dependencyResult = await checkpoint(runtime, dependency, "engineering-b");
  const resumed = await runtime.combineBase({
    attempt: 3,
    requesterCheckpointSha: secretCheckpoint.resultSha,
    dependencyResultSha: dependencyResult.resultSha,
    deadlineAt: futureDeadline(),
  });
  await unlink(path.join(resumed.workspace.root, "src", "transient-secret.txt"));
  await writeFile(path.join(resumed.workspace.root, "src", "app.mjs"), "export const app = 'history clean';\n");
  const finalRequester = await checkpoint(runtime, resumed.workspace, "engineering-a");
  const historyQa = await writer(runtime, fixture, {
    attempt: 3,
    ownerSlot: "qa-tests",
    writePaths: ["test"],
  });
  await writeFile(path.join(historyQa.root, "test", "app.test.mjs"), "// history QA\n");
  const historyQaResult = await checkpoint(runtime, historyQa, "qa-tests");
  const historyCandidate = await runtime.integrate({
    attempt: 3,
    baseSha: fixture.baseSha,
    commits: [finalRequester, dependencyResult, historyQaResult],
    integrationOrder: ["engineering-a", "engineering-b", "qa-tests"],
    branch: "monolith/scan-3",
    deadlineAt: futureDeadline(),
  });
  await assert.rejects(lstat(path.join(historyCandidate.workspaceRoot, "src", "transient-secret.txt")), /ENOENT/);
  await assert.rejects(runtime.scan({
    baseSha: fixture.baseSha,
    candidateSha: historyCandidate.candidateSha,
    deadlineAt: futureDeadline(),
  }), /reachable history/);
  await runtime.close({ deadlineAt: futureDeadline() });
});

test("binds staged object bytes after freezing the writer tree", async (t) => {
  const fixture = await repositoryFixture(t);
  let workspaceRoot;
  let openWriter;
  let raced = false;
  const runner = async (command, args, options) => {
    if (
      workspaceRoot !== undefined
      && !raced
      && args.includes("add")
      && !args.includes("worktree")
    ) {
      raced = true;
      const oversized = Buffer.alloc(1_024, 0x78);
      await openWriter.write(oversized, 0, oversized.length, 0);
      await openWriter.truncate(oversized.length);
    }
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      maxBuffer: options.maxOutputBytes,
      encoding: null,
    });
    return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
  };
  const runtime = runtimeFor(fixture, { runner });
  await prepare(runtime, fixture);
  const workspace = await writer(runtime, fixture);
  workspaceRoot = workspace.root;
  const changed = path.join(workspace.root, "src", "app.mjs");
  await writeFile(changed, "short\n");
  openWriter = await open(changed, "r+");
  try {
    await assert.rejects(checkpoint(runtime, workspace, "engineering-a", {
      maxBytes: 100,
    }), /changed-byte limit|changed between inspection and staging/);
  } finally {
    await openWriter.close();
  }
  assert.equal(raced, true);
  assert.equal(await git(workspace.root, ["rev-parse", "HEAD"]), fixture.baseSha);
  await runtime.close({ deadlineAt: futureDeadline() });
});

test("refuses a pre-seeded controller Git root without deleting its contents", async (t) => {
  const fixture = await repositoryFixture(t);
  const gitRoot = path.join(fixture.temporary, "preseeded-controller");
  await mkdir(path.join(gitRoot, ".home"), { recursive: true, mode: 0o700 });
  const sentinel = path.join(gitRoot, ".home", ".gitconfig");
  await writeFile(sentinel, "[url \"file:///attacker\"]\n\tinsteadOf = https://github.com/\n");
  const runtime = runtimeFor(fixture, {
    gitRoot,
    snapshotsRoot: path.join(fixture.temporary, "preseeded-snapshots"),
    worktreesRoot: path.join(fixture.temporary, "preseeded-worktrees"),
    runId: "preseeded",
  });
  await assert.rejects(prepare(runtime, fixture), /Git root must be empty/);
  await runtime.close({ deadlineAt: futureDeadline() });
  assert.match(await readFile(sentinel, "utf8"), /insteadOf/);
});

test("rejects overlapping writer roots at construction", async (t) => {
  const fixture = await repositoryFixture(t);
  assert.throws(() => runtimeFor(fixture, {
    allowedWriteRoots: {
      "engineering-a": ["src"],
      "engineering-b": ["src/generated"],
      "qa-tests": ["test"],
    },
  }), /allowed write roots overlap/);
});

test("passes argv arrays and an absolute deadline to the injected command runner", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monolith-git-runner-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    throw new Error("stop after argv capture");
  };
  const runtime = new GitRuntime({
    allowedRepositories: [REPOSITORY],
    gitRoot: path.join(temporary, "controller"),
    snapshotsRoot: path.join(temporary, "snapshots"),
    worktreesRoot: path.join(temporary, "worktrees"),
    runId: "run-1",
    allowedWriteRoots: {
      "engineering-a": ["src"],
      "engineering-b": ["templates"],
      "qa-tests": ["test"],
    },
    runner,
  });
  const deadlineAt = futureDeadline();
  await assert.rejects(runtime.prepareAssignment({
    repository: REPOSITORY,
    baseRevision: "a".repeat(40),
    targetBranch: "main",
    deadlineAt,
  }), /stop after argv capture/);
  assert.equal(calls[0].command, "git");
  assert.ok(Array.isArray(calls[0].args));
  assert.equal(calls[0].options.deadlineAt, deadlineAt);
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.equal(calls[0].options.env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.deepEqual(calls[0].args.slice(0, 2), ["-c", "http.followRedirects=false"]);
  await runtime.close({ deadlineAt: futureDeadline() });
});

test("aborts an injected Git command at the absolute deadline and waits for settlement", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "monolith-git-deadline-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  let settled = false;
  const runner = (_command, _args, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      settled = true;
      reject(new Error("runner aborted"));
    }, { once: true });
  });
  const runtime = new GitRuntime({
    allowedRepositories: [REPOSITORY],
    gitRoot: path.join(temporary, "controller"),
    snapshotsRoot: path.join(temporary, "snapshots"),
    worktreesRoot: path.join(temporary, "worktrees"),
    runId: "run-1",
    allowedWriteRoots: {
      "engineering-a": ["src"],
      "engineering-b": ["templates"],
      "qa-tests": ["test"],
    },
    runner,
  });
  const startedAt = Date.now();
  await assert.rejects(runtime.prepareAssignment({
    repository: REPOSITORY,
    baseRevision: "a".repeat(40),
    targetBranch: "main",
    deadlineAt: Date.now() + 500,
  }), /Git operation deadline exceeded/);
  assert.equal(settled, true);
  assert.ok(Date.now() - startedAt < 1_000);
  await runtime.close({ deadlineAt: futureDeadline() });
});
