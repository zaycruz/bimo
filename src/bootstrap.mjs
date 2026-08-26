#!/usr/bin/env node

import { cp, lstat, readdir } from "node:fs/promises";
import path from "node:path";

const WORKSPACE = "/workspace";
const STARTER = "/app/starters/react";
const DEPENDENCIES = "/opt/bimo-react/node_modules";
const REQUIRED = ["package.json", "package-lock.json", "node_modules"];

function fail(message) {
  throw new Error(message);
}

async function regularDirectory(target, label) {
  const stat = await lstat(target).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a regular directory`);
}

async function main() {
  if (process.argv.length !== 2) fail("bootstrap accepts no options");
  await regularDirectory(WORKSPACE, "workspace");
  await regularDirectory(STARTER, "React starter");
  await regularDirectory(DEPENDENCIES, "React dependency seed");

  const entries = await readdir(WORKSPACE);
  if (entries.length === 0) {
    for (const entry of await readdir(STARTER)) {
      await cp(path.join(STARTER, entry), path.join(WORKSPACE, entry), {
        errorOnExist: true,
        recursive: true,
      });
    }
    await cp(DEPENDENCIES, path.join(WORKSPACE, "node_modules"), {
      errorOnExist: true,
      recursive: true,
      verbatimSymlinks: true,
    });
    process.stdout.write('{"status":"seeded"}\n');
    return;
  }

  for (const entry of REQUIRED) {
    if (!await lstat(path.join(WORKSPACE, entry)).catch(() => null)) {
      fail(`non-empty workspace is missing ${entry}; clear it before bootstrapping`);
    }
  }
  process.stdout.write('{"status":"existing"}\n');
}

main().catch(error => {
  process.stderr.write(`bimo-bootstrap: ${error.message}\n`);
  process.exitCode = 1;
});
