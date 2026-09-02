// .claude/hooks/lib/gh-pr-command-detect.mjs
//
// Shared shell-command detection for pre-pr-precheck-node.js and
// review-before-merge-node.js. Extracted after Copilot flagged the two
// hooks carrying identical copies — keeping one copy means a future bypass
// fix (or bug) can't land in one hook and be missed in the other.
//
// Exports splitShellStatements, tokenize, and findGhPrInvocation.

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

// Finds the `gh pr <subcommand>` invocation across all statements in the
// command, allowing leading env var assignments (e.g. `FOO=bar gh pr merge
// ...`, or `FOO="a b" gh pr merge ...`), which would otherwise bypass the
// gate entirely. Returns the invocation's own argument tokens (with "gh",
// "pr", <subcommand>, and any leading env assignments already stripped),
// or null if no statement actually invokes it.
export function findGhPrInvocation(command, subcommand) {
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
