// Relaxes every OpenClaw extension's own `"openclaw"` version constraint (a
// strict `">=X"` range, or a `"workspace:X"` link) to `"*"`, across every
// `extensions/*/package.json` in a cloned OpenClaw checkout.
//
// Extracted from the Dockerfile's own former inline `sed` loop (issue #104)
// so both the real build (openclaw-build stage) and the lockfile-regeneration
// path (scripts/generate-openclaw-lockfile.sh, openclaw-lockfile-refresh
// stage) run identical relaxation logic -- a single source of truth, not two
// copies that can quietly drift apart, matching the shared-detector rationale
// already established in .claude/hooks/lib/gh-pr-command-detect.mjs.
//
// usage: node relax-openclaw-extension-versions.mjs <path-to-openclaw-checkout>

import fs from "node:fs";
import path from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node relax-openclaw-extension-versions.mjs <path-to-openclaw-checkout>");
  process.exit(1);
}

const extensionsDir = path.join(root, "extensions");
if (!fs.existsSync(extensionsDir)) {
  console.error(
    `expected an "extensions" directory at ${extensionsDir} -- the pinned OpenClaw source may have changed shape; re-verify this script's assumptions before proceeding.`,
  );
  process.exit(1);
}

function findPackageJsonFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findPackageJsonFiles(full));
    } else if (entry.isFile() && entry.name === "package.json") {
      results.push(full);
    }
  }
  return results;
}

// Same two patterns as the Dockerfile's former sed loop:
//   's/"openclaw"[[:space:]]*:[[:space:]]*">=[^"]+"/"openclaw": "*"/g'
//   's/"openclaw"[[:space:]]*:[[:space:]]*"workspace:[^"]+"/"openclaw": "*"/g'
const RANGE_CONSTRAINT_RE = /("openclaw"\s*:\s*")>=[^"]+(")/g;
const WORKSPACE_CONSTRAINT_RE = /("openclaw"\s*:\s*")workspace:[^"]+(")/g;

const files = findPackageJsonFiles(extensionsDir);
if (files.length === 0) {
  console.error(`no package.json files found under ${extensionsDir} -- the pinned OpenClaw source may have changed shape.`);
  process.exit(1);
}

let changedFileCount = 0;
for (const file of files) {
  const original = fs.readFileSync(file, "utf8");
  const rewritten = original.replace(RANGE_CONSTRAINT_RE, "$1*$2").replace(WORKSPACE_CONSTRAINT_RE, "$1*$2");
  if (rewritten !== original) {
    fs.writeFileSync(file, rewritten);
    changedFileCount++;
  }
}

// A single extension with no "openclaw" constraint at all is unremarkable,
// but zero relaxations across the ENTIRE extension set would mean this
// script's regexes no longer match anything real -- the pinned OpenClaw
// source's own versioning convention changed shape. Fail loudly rather than
// silently produce an unrelaxed (and likely un-installable) dependency graph.
if (changedFileCount === 0) {
  console.error(
    `relaxed 0 of ${files.length} extension package.json file(s) under ${extensionsDir} -- ` +
      'expected at least one "openclaw": ">=X" or "workspace:X" constraint. The pinned OpenClaw source\'s ' +
      "own versioning convention may have changed; re-verify this script's regexes before proceeding.",
  );
  process.exit(1);
}

console.log(
  `relaxed "openclaw" version constraint to "*" in ${changedFileCount}/${files.length} extension package.json file(s) under ${extensionsDir}`,
);
