#!/usr/bin/env node
// scripts/write-precheck-stamp.mjs
//
// Last step of `npm run precheck`. Only runs if typecheck+test+build all
// succeeded (chained with &&), so its presence with a matching sha is proof
// precheck passed on that exact commit. Read by
// .claude/hooks/pre-pr-precheck-node.js to gate `gh pr create`.
//
// Refuses to run outside of `npm run precheck` itself — invoking this file
// directly (`node scripts/write-precheck-stamp.mjs`) would otherwise forge
// a "passed: true" stamp with no actual typecheck/test/build having run.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.npm_lifecycle_event !== "precheck") {
  process.stderr.write(
    "Refusing to run outside `npm run precheck` — this script only records that precheck's " +
      "typecheck+test+build already passed; it does not run them itself.\n"
  );
  process.exit(1);
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const stampPath = fileURLToPath(new URL("../.claude/precheck-stamp.json", import.meta.url));

const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;

mkdirSync(dirname(stampPath), { recursive: true });
writeFileSync(
  stampPath,
  JSON.stringify(
    {
      sha,
      dirty,
      timestamp: new Date().toISOString(),
      passed: true,
    },
    null,
    2
  ) + "\n"
);

process.stdout.write(`precheck stamp written for ${sha}${dirty ? " (dirty tree)" : ""}\n`);
