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

// Quote-aware statement splitter. Three failure modes were caught live
// while iterating on this detector, and this is the one approach that
// avoids all three:
//   1. A plain substring match (`\bgh\s+pr\s+merge\b` anywhere in the
//      string) false-fires on prose that merely mentions the phrase, e.g.
//      a commit message describing this hook.
//   2. Splitting on every `&&`/`;`/`|`/newline WITHOUT tracking quotes
//      breaks apart inside a quoted string (e.g. a JSON test payload whose
//      string value happens to contain "&&"), producing a fragment that
//      accidentally starts with the target phrase.
//   3. Anchoring to only the very start of the whole command (plus one
//      allowed `cd ... &&` prefix) is bypassable: `npm test && gh pr merge
//      ...` never matches the anchor, yet the merge still runs.
// Splitting on unquoted separators only, then checking each resulting
// statement's own start, avoids all three: quoted content never produces a
// false split, and every real command position (chained, sequenced, or
// piped) is still checked.
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

// Word-tokenize one already-isolated shell statement (quote-aware, same
// quote-tracking rules as splitShellStatements). Used to parse `gh pr
// merge`'s own arguments without re-scanning the raw command string, which
// would risk pulling tokens from an unrelated chained command.
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

// Finds the `gh pr <subcommand>` invocation across all statements in the
// command, allowing leading env var assignments (e.g. `FOO=bar gh pr merge
// ...`, or `FOO="a b" gh pr merge ...`), which would otherwise bypass the
// gate entirely. Returns the invocation's own argument tokens (with "gh",
// "pr", <subcommand>, and any leading env assignments already stripped),
// or null if no statement actually invokes it.
//
// Tokenizes each statement FIRST, then walks tokens — rather than matching
// env assignments with a `\S*` regex against the raw string — because a
// whitespace-based regex can't see past a space inside a quoted value
// (`FOO="a b"` is one token after tokenize(), two words to a naive regex).
function findGhPrInvocation(command, subcommand) {
  for (const stmt of splitShellStatements(command)) {
    const tokens = tokenize(stmt);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++;
    if (tokens[i] === "gh" && tokens[i + 1] === "pr" && tokens[i + 2] === subcommand) {
      return tokens.slice(i + 3);
    }
  }
  return null;
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

  const tokens = findGhPrInvocation(command, "merge");
  if (!tokens) {
    process.exit(0);
  }

  // `gh pr merge --help`/`-h` never merges anything — don't gate it.
  if (tokens.includes("--help") || tokens.includes("-h")) {
    process.exit(0);
  }

  // Value-taking flags per `gh pr merge --help` — their value token must
  // not be mistaken for the merge target (a bare regex over the whole
  // command previously could, e.g., capture `--subject`'s value).
  const VALUE_FLAGS = new Set([
    "-A", "--author-email",
    "-b", "--body",
    "-F", "--body-file",
    "--match-head-commit",
    "-t", "--subject",
    "-R", "--repo",
  ]);
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
process.stdin.on("end", () => main(input));
