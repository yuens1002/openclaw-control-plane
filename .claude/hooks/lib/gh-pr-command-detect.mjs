// .claude/hooks/lib/gh-pr-command-detect.mjs
//
// Shared shell-command detection for pre-pr-precheck-node.js and
// review-before-merge-node.js. Extracted after Copilot flagged the two
// hooks carrying identical copies — keeping one copy means a future bypass
// fix (or bug) can't land in one hook and be missed in the other.
//
// Exports splitShellStatements, tokenize, findGhPrInvocation, and
// VALUE_FLAGS_BY_SUBCOMMAND.
//
// Scope — this is a best-effort guardrail against the agent forgetting the
// procedure, not a security boundary against a deliberately adversarial
// shell command. It recognizes the first word of each `&&`/`||`/`;`/`|`/
// newline-separated statement (after any leading `VAR=value` assignments)
// as `gh`/`gh.exe` (case-insensitive) + `pr` + a known subcommand or alias.
// Known gaps, accepted rather than chased further (see docs/AGENTIC-
// WORKFLOW.md "Enforcement hooks — scope"):
//   - Subshells, command substitution (`$(...)`), `bash -c "..."`.
//   - Wrapper commands: `exec gh ...`, `env gh ...`, `command gh ...`.
//   - Background separator (`&`) and backslash-newline line continuation.
//   - Only wired to Claude Code's Bash tool (see .claude/settings.json) —
//     the PowerShell tool and the GitHub MCP tools (merge_pull_request,
//     create_pull_request) bypass these hooks entirely.

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
export function splitShellStatements(command) {
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
// quote-tracking rules as splitShellStatements). Used both to parse a `gh
// pr <subcommand>` invocation's own arguments and, upstream of that, to
// detect env var assignments correctly — a `\S*`-based regex on the raw
// string can't see past a space inside a quoted value (`FOO="a b"` is one
// token after tokenize(), two words to a naive regex).
export function tokenize(statement) {
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

// `gh pr create` and `gh pr merge` each accept a documented alias (`gh pr
// new`, `gh pr merge` has none but the table stays shape-consistent for the
// next subcommand this gets used for).
const SUBCOMMAND_ALIASES = {
  create: ["create", "new"],
  merge: ["merge"],
};

// Value-taking flags per `gh pr <subcommand> --help`, keyed by subcommand.
// A value-flag's value token must never be scanned for a bare `--help`/`-h`
// or mistaken for the merge/create target — `gh pr merge 123 --body --help`
// really merges PR 123 with body text "--help" (gh's own flag parser
// consumes "--help" as --body's value); a scan that doesn't know --body
// takes a value would see the literal string "--help" in the token list and
// wrongly treat the whole invocation as a no-op help call.
export const VALUE_FLAGS_BY_SUBCOMMAND = {
  merge: new Set([
    "-A", "--author-email",
    "-b", "--body",
    "-F", "--body-file",
    "--match-head-commit",
    "-t", "--subject",
    "-R", "--repo",
  ]),
  create: new Set([
    "-a", "--assignee",
    "-B", "--base",
    "-b", "--body",
    "-F", "--body-file",
    "-H", "--head",
    "-l", "--label",
    "-m", "--milestone",
    "-p", "--project",
    "--recover",
    "-r", "--reviewer",
    "-T", "--template",
    "-t", "--title",
    "-R", "--repo",
  ]),
};

// Finds the `gh pr <subcommand>` invocation across all statements in the
// command, allowing leading env var assignments (e.g. `FOO=bar gh pr merge
// ...`, or `FOO="a b" gh pr merge ...`), which would otherwise bypass the
// gate entirely. Matches `gh`/`gh.exe` case-insensitively and accepts the
// subcommand's documented aliases (`gh pr new` for `create`).
//
// Returns `{ tokens, isHelp }` — `tokens` is the invocation's own argument
// tokens (with "gh", "pr", <subcommand>, and any leading env assignments
// already stripped); `isHelp` is true only when `--help`/`-h` appears at an
// actual flag position, never when it's consumed as a preceding value-flag's
// value. Returns null if no statement actually invokes the subcommand.
//
// Known non-coverage (see the module header above): subshells, command
// substitution, `bash -c`, wrapper commands (`exec`/`env`/`command`/`time`),
// background `&`, backslash-newline continuation. `-R/--repo`'s value is
// recognized as the flag's argument here (so it doesn't get mistaken for the
// target) but is not forwarded to the caller's own `gh pr view`/GraphQL
// calls — this repo has no multi-repo workflow that passes `-R`, so that gap
// is accepted rather than plumbed through.
export function findGhPrInvocation(command, subcommand) {
  const aliases = SUBCOMMAND_ALIASES[subcommand] ?? [subcommand];
  const valueFlags = VALUE_FLAGS_BY_SUBCOMMAND[subcommand] ?? new Set();
  for (const stmt of splitShellStatements(command)) {
    const tokens = tokenize(stmt);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i])) i++;
    const isGh = /^gh(\.exe)?$/i.test(tokens[i] ?? "");
    const isPr = /^pr$/i.test(tokens[i + 1] ?? "");
    const subTok = (tokens[i + 2] ?? "").toLowerCase();
    if (isGh && isPr && aliases.includes(subTok)) {
      const argTokens = tokens.slice(i + 3);
      let isHelp = false;
      for (let j = 0; j < argTokens.length; j++) {
        const tok = argTokens[j];
        if (tok === "--help" || tok === "-h") {
          isHelp = true;
          break;
        }
        if (tok.startsWith("-")) {
          const [flag] = tok.split("=");
          if (valueFlags.has(flag) && !tok.includes("=")) j++; // skip its value token
        }
      }
      return { tokens: argTokens, isHelp };
    }
  }
  return null;
}
