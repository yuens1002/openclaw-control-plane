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
// See lib/gh-pr-command-detect.mjs's header for this hook's detection scope
// and known non-coverage — it is a guardrail against the agent forgetting
// the procedure, not a security boundary against an adversarial command.
//
// Exit 0 = allow, exit 2 = block (reason on stderr).

import { execFileSync } from "node:child_process";
import { findGhPrInvocation, VALUE_FLAGS_BY_SUBCOMMAND } from "./lib/gh-pr-command-detect.mjs";

function deny(reason) {
  process.stderr.write(reason);
  process.exit(2);
}

function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

// A PR with >50 review threads would otherwise silently drop the tail past
// page 1, letting an unresolved thread past. Page through all of them.
function fetchAllReviewThreads(prNumber) {
  const { owner, repo } = repoNwo();
  const threads = [];
  let after = null;
  for (;;) {
    const afterArg = after ? `, after: "${after}"` : "";
    const query = `query {
  repository(owner: "${owner}", name: "${repo}") {
    pullRequest(number: ${prNumber}) {
      reviewThreads(first: 50${afterArg}) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
    const json = gh(["api", "graphql", "-f", `query=${query}`]);
    const page = JSON.parse(json).data.repository.pullRequest.reviewThreads;
    threads.push(...page.nodes);
    if (!page.pageInfo.hasNextPage) break;
    after = page.pageInfo.endCursor;
  }
  return threads;
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

  const invocation = findGhPrInvocation(command, "merge");
  if (!invocation) {
    process.exit(0);
  }

  // `gh pr merge --help`/`-h` never merges anything — don't gate it. This
  // trusts isHelp's flag-position-aware detection rather than scanning
  // tokens directly: `gh pr merge 123 --body --help` really merges PR 123
  // with body text "--help" (gh's own flag parser consumes "--help" as
  // --body's value) — a bare `tokens.includes("--help")` check would see
  // that literal string in the array and wrongly wave the real merge through.
  if (invocation.isHelp) {
    process.exit(0);
  }

  const { tokens } = invocation;
  const VALUE_FLAGS = VALUE_FLAGS_BY_SUBCOMMAND.merge;
  let target = "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith("-")) {
      const [flag] = tok.split("=");
      if (VALUE_FLAGS.has(flag) && !tok.includes("=")) i++; // skip its value token
      continue;
    }
    target = tok;
    break;
  }

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
    threads = fetchAllReviewThreads(pr.number);
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
process.stdin.on("end", () => {
  try {
    main(input);
  } catch (err) {
    // A gate that crashes fail-open (Claude Code treats a non-0/2 exit as a
    // non-blocking error) is worse than useless — it looks like enforcement
    // but silently lets everything through the moment its own code throws.
    deny(`BLOCKED: review-before-merge hook crashed (${String(err && err.message ? err.message : err)}). Fix the hook or investigate before merging.`);
  }
});
