#!/usr/bin/env node
// scripts/write-precheck-stamp.mjs
//
// Last step of `npm run precheck`. Only runs if typecheck+test+build all
// succeeded (chained with &&), so its presence with a matching sha is proof
// precheck passed on that exact commit. Read by
// .claude/hooks/pre-pr-precheck-node.js to gate `gh pr create`.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const stampPath = fileURLToPath(new URL("../.claude/precheck-stamp.json", import.meta.url));

const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;

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
