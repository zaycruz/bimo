#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const RESULT = /^MONOLITH_RESULT=([a-z][a-z0-9_-]*)$/gm;

function fail(message) { throw new Error(message); }

function parseArgs(argv) {
  const [command, spec, ...rest] = argv;
  if (!command || !spec) fail("usage: monolith <validate|run> SPEC [options]");
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(`invalid option: ${key ?? ""}`);
    options[key.slice(2)] = value;
  }
  return { command, spec: path.resolve(spec), options };
}

async function loadSpec(specPath) {
  const spec = JSON.parse(await readFile(specPath, "utf8"));
  if (!spec.name || !spec.start || !Number.isInteger(spec.maxRounds) || spec.maxRounds < 1) {
    fail("workflow requires name, start, and positive maxRounds");
  }
  if (!Array.isArray(spec.agent) || !spec.agent.length || !spec.roles || !spec.states) {
    fail("workflow requires agent, roles, and states");
  }
  if (!spec.states[spec.start]) fail(`unknown start state: ${spec.start}`);
  for (const [name, state] of Object.entries(spec.states)) {
    if (!spec.roles[state.role]) fail(`state ${name} uses unknown role ${state.role}`);
    if (!state.on || !Object.keys(state.on).length) fail(`state ${name} has no transitions`);
    for (const next of Object.values(state.on)) {
      if (next !== "done" && !spec.states[next]) fail(`state ${name} targets unknown state ${next}`);
    }
  }
  return spec;
}

async function rolePrompt(specPath, roleFile) {
  const base = path.dirname(specPath);
  const target = path.resolve(base, roleFile);
  const root = path.resolve(base, "..");
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    fail(`role prompt escapes workflow root: ${roleFile}`);
  }
  return readFile(target, "utf8");
}

function invoke(command, prompt, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], [...command.slice(1), prompt], {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; process.stdout.write(chunk); });
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(output) : reject(new Error(`${command[0]} exited ${code}`)));
  });
}

async function saveState(stateDir, state) {
  await mkdir(stateDir, { recursive: true });
  const target = path.join(stateDir, "run.json");
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, target);
}

function agentCommand(spec) {
  const encoded = process.env.MONOLITH_AGENT_COMMAND_B64;
  const command = encoded
    ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))
    : process.env.MONOLITH_AGENT_COMMAND_JSON
      ? JSON.parse(process.env.MONOLITH_AGENT_COMMAND_JSON)
      : spec.agent;
  if (!Array.isArray(command) || !command.length || !command.every(value => typeof value === "string")) {
    fail("agent command must be a non-empty JSON string array");
  }
  return command;
}

async function run(specPath, spec, task, stateDir, workspace) {
  const state = { workflow: spec.name, task, status: "running", current: spec.start, round: 1, history: [] };
  await saveState(stateDir, state);

  while (state.status === "running") {
    if (state.round > spec.maxRounds) {
      state.status = "failed";
      state.reason = "max rounds reached";
      await saveState(stateDir, state);
      fail(state.reason);
    }

    const current = state.current;
    const step = spec.states[current];
    const allowed = Object.keys(step.on);
    const prompt = [
      `[workflow=${spec.name}] [role=${step.role}] [round=${state.round}]`,
      await rolePrompt(specPath, spec.roles[step.role]),
      `Task:\n${task}`,
      `Prior results:\n${state.history.map(item => `${item.state}: ${item.result}\n${item.message}`).join("\n\n") || "none"}`,
      `Allowed result markers: ${allowed.map(value => `MONOLITH_RESULT=${value}`).join(", ")}`,
    ].join("\n\n");

    const output = await invoke(agentCommand(spec), prompt, workspace);
    const results = [...output.matchAll(RESULT)].map(match => match[1]);
    if (results.length !== 1 || !allowed.includes(results[0])) {
      fail(`${current} must return exactly one allowed MONOLITH_RESULT marker`);
    }

    const result = results[0];
    const next = step.on[result];
    const message = output.replace(RESULT, "").trim();
    state.history.push({ state: current, role: step.role, result, message });
    if (next === "done") {
      state.current = "done";
      state.status = "completed";
    } else {
      if (next === spec.start) state.round += 1;
      state.current = next;
    }
    await saveState(stateDir, state);
  }

  console.log(`workflow ${spec.name} completed in ${state.round} round(s)`);
}

async function main() {
  const { command, spec: specPath, options } = parseArgs(process.argv.slice(2));
  const spec = await loadSpec(specPath);
  if (command === "validate") return console.log(`valid workflow ${spec.name}`);
  if (command !== "run") fail(`unknown command: ${command}`);

  let task = options.task;
  if (options["task-base64-env"]) {
    const encoded = process.env[options["task-base64-env"]];
    if (!encoded) fail(`missing task environment: ${options["task-base64-env"]}`);
    task = Buffer.from(encoded, "base64").toString("utf8");
  }
  if (!task) fail("run requires --task");
  await run(
    specPath,
    spec,
    task,
    path.resolve(options["state-dir"] ?? ".monolith"),
    path.resolve(options.workspace ?? process.cwd()),
  );
}

main().catch(error => {
  console.error(`monolith: ${error.message}`);
  process.exitCode = 1;
});
