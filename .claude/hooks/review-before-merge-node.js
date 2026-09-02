#!/usr/bin/env node
// .claude/hooks/review-before-merge-node.js
//
// Claude Code PreToolUse hook (Bash) — gates `gh pr merge` on a Copilot
// review attached to the PR's current head SHA, with every review thread
// resolved. Mirrors the manual procedure this repo already follows (see
// PR #95: request_copilot_review -> poll -> resolve threads -> merge).
//
// Uses execFileSync (argv arrays, no shell) throughout — execSync would
// shell out via cmd.exe on Windows, which mangles multi-line/quoted
// arguments like the GraphQL query below.
//
// Exit 0 = allow, exit 2 = block (reason on stderr).

import { execFileSync } from "node:child_process";

function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

// Anchor to the START of the command only (matching this repo's existing
// verify-before-commit-node.js convention: `/^\s*git commit/i`), plus one
// allowed `cd <path> &&` prefix (an allowlisted pattern for `gh` in
// ~/.claude/settings.json). Do NOT scan for the phrase anywhere in the
// string or split on every `&&`/`;`/`|`/newline — both are unsafe: a plain
// substring match false-fires on prose that merely mentions the phrase
// (caught live: a commit message describing this hook tripped it), and
// naive splitting on separators breaks inside quoted strings (also caught
// live: a test payload's JSON value containing "&&" got split mid-string,
// producing a fragment that happened to start with "gh pr merge").
function commandInvokesGhPr(command, subcommand) {
  const stripped = command.replace(/^\s*cd\s+\S+\s*&&\s*/i, "");
  return new RegExp(`^\\s*gh\\s+pr\\s+${subcommand}\\b`).test(stripped);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function repoNwo() {
  const url = execFileSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }).trim();
  const match = url.match(/[/:]([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match) throw new Error(`Could not parse owner/repo from remote URL: ${url}`);
  return { owner: match[1], repo: match[2] };
}

function main(input) {
  let command = "";
  try {
    const parsed = JSON.parse(input);
    command = (parsed.tool_input && parsed.tool_input.command) || "";
  } catch {
    process.exit(0);
  }

  if (!commandInvokesGhPr(command, "merge")) {
    process.exit(0);
  }

  // Extract an explicit PR number/branch argument if present; otherwise
  // `gh pr view` resolves the PR for the current branch.
  const argMatch = command.match(/\bgh\s+pr\s+merge\s+(?:--\S+\s+)*(\d+|\S+)/);
  const target = argMatch && !argMatch[1].startsWith("-") ? argMatch[1] : "";

  let pr;
  try {
    const viewArgs = ["pr", "view"];
    if (target) viewArgs.push(target);
    viewArgs.push("--json", "number,headRefOid,reviews");
    pr = JSON.parse(gh(viewArgs));
  } catch (err) {
    deny(`BLOCKED: could not look up the PR to check review status (${String(err.message || err)}).`);
    return;
  }

  const headSha = pr.headRefOid;
  const freshReview = (pr.reviews || [])
    .filter((r) => r.commit && r.commit.oid === headSha)
    .find((r) => (r.author && r.author.login) === "copilot-pull-request-reviewer");

  if (!freshReview) {
    deny(
      `BLOCKED: no Copilot review found on PR #${pr.number}'s current head (${headSha}).\n` +
        `Request one (request_copilot_review) and wait for it before merging.`
    );
    return;
  }

  let threads;
  try {
    const { owner, repo } = repoNwo();
    const query = `query {
  repository(owner: "${owner}", name: "${repo}") {
    pullRequest(number: ${pr.number}) {
      reviewThreads(first: 50) { nodes { isResolved } }
    }
  }
}`;
    const json = gh(["api", "graphql", "-f", `query=${query}`]);
    threads = JSON.parse(json).data.repository.pullRequest.reviewThreads.nodes;
  } catch (err) {
    deny(`BLOCKED: could not check review thread resolution (${String(err.message || err)}).`);
    return;
  }

  const unresolved = threads.filter((t) => !t.isResolved).length;
  if (unresolved > 0) {
    deny(
      `BLOCKED: PR #${pr.number} has ${unresolved} unresolved review thread(s). Resolve them before merging.`
    );
    return;
  }

  process.exit(0);
}

let input = "";
process.stdin.on("data", (chunk) => (input += chunk));
process.stdin.on("end", () => main(input));
