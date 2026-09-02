#!/usr/bin/env node
// .claude/hooks/pre-pr-precheck-node.js
//
// Claude Code PreToolUse hook (Bash) — gates `gh pr create` on a fresh
// `npm run precheck` stamp (.claude/precheck-stamp.json) matching HEAD.
//
// Exit 0 = allow, exit 2 = block (reason on stderr).

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { findGhPrInvocation } from "./lib/gh-pr-command-detect.mjs";

function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

// `gh pr create` may run from a subdirectory (`cd packages/foo && gh ...`
// is an allowlisted pattern). Walk up from cwd to find the repo root,
// matching the convention in enforce-workflow-start.js / verify-before-
// commit-node.js — don't assume process.cwd() is the root.
function findProjectDir(startDir) {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, ".claude"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

function main(input) {
  let command = "";
  try {
    const parsed = JSON.parse(input);
    command = (parsed.tool_input && parsed.tool_input.command) || "";
  } catch {
    process.exit(0);
  }

  const tokens = findGhPrInvocation(command, "create");
  if (!tokens) {
    process.exit(0);
  }

  // `gh pr create --help`/`-h` never creates anything — don't gate it.
  if (tokens.includes("--help") || tokens.includes("-h")) {
    process.exit(0);
  }

  const projectDir = findProjectDir(process.cwd());
  const stampPath = path.join(projectDir, ".claude", "precheck-stamp.json");

  if (!fs.existsSync(stampPath)) {
    deny(
      "BLOCKED: no precheck stamp found. Run `npm run precheck` (typecheck + test + build) before opening a PR."
    );
  }

  let stamp;
  try {
    stamp = JSON.parse(fs.readFileSync(stampPath, "utf8"));
  } catch {
    deny("BLOCKED: .claude/precheck-stamp.json is unreadable. Re-run `npm run precheck`.");
  }

  let headSha = "";
  try {
    headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectDir, encoding: "utf8" }).trim();
  } catch {
    // Can't determine HEAD — allow rather than block on an environment issue.
    process.exit(0);
  }

  if (!stamp.passed) {
    deny("BLOCKED: last `npm run precheck` did not pass. Fix and re-run before opening a PR.");
  }

  if (stamp.dirty) {
    deny(
      "BLOCKED: precheck stamp was written against a dirty working tree — it doesn't prove the committed state passes. Commit, then re-run `npm run precheck`."
    );
  }

  if (stamp.sha !== headSha) {
    deny(
      `BLOCKED: precheck stamp is for ${stamp.sha}, but HEAD is ${headSha}. Re-run \`npm run precheck\` on the current commit before opening a PR.`
    );
  }

  process.exit(0);
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => main(input));
