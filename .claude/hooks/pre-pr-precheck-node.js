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

function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

// Quote-aware statement splitter — see the full explanation of the three
// failure modes this avoids in review-before-merge-node.js's copy of this
// function (prose false-match; naive-split-inside-quotes false-match;
// start-anchor-only bypass via `other-cmd && gh pr create`).
function splitShellStatements(command) {
  const statements = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === "\\" && i + 1 < command.length) {
        current += command[++i];
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i++;
      continue;
    }
    if (command.startsWith("&&", i) || command.startsWith("||", i)) {
      statements.push(current);
      current = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "\n" || ch === "|") {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) statements.push(current);
  return statements;
}

// Word-tokenize one already-isolated shell statement — same quote-tracking
// rules as splitShellStatements. Used only to check for --help/-h below.
function tokenize(statement) {
  const tokens = [];
  let current = "";
  let quote = null;
  let inToken = false;
  for (let i = 0; i < statement.length; i++) {
    const ch = statement[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (quote === '"' && ch === "\\" && i + 1 < statement.length) {
        current += statement[++i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    if (ch === "\\" && i + 1 < statement.length) {
      current += statement[++i];
      inToken = true;
      continue;
    }
    current += ch;
    inToken = true;
  }
  if (inToken) tokens.push(current);
  return tokens;
}

// Finds the actual `gh pr <subcommand>` statement, allowing leading env
// var assignments (e.g. `FOO=bar gh pr create ...`), which would otherwise
// bypass the gate entirely.
function findGhPrStatement(command, subcommand) {
  const pattern = new RegExp(`^\\s*(?:[A-Za-z_]\\w*=\\S*\\s+)*gh\\s+pr\\s+${subcommand}\\b`);
  return splitShellStatements(command).find((stmt) => pattern.test(stmt)) ?? null;
}

// See the matching comment in review-before-merge-node.js: the statement
// may carry leading env var assignment tokens before "gh", so a fixed
// slice(3) to drop "gh"/"pr"/<subcommand> would be off by however many of
// those precede it.
function dropGhPrPrefix(tokens, subcommand) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++;
  return tokens.slice(i + 3); // "gh", "pr", subcommand
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

  const statement = findGhPrStatement(command, "create");
  if (!statement) {
    process.exit(0);
  }

  // `gh pr create --help`/`-h` never creates anything — don't gate it.
  const tokens = dropGhPrPrefix(tokenize(statement), "create");
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
