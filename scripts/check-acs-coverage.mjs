#!/usr/bin/env node
// scripts/check-acs-coverage.mjs
//
// Gate 1 (agentic-workflow Phase 1.5): hard-fails on any deliverable in a
// plan.md with no AC row referencing it, or any AC row whose Plan ref
// doesn't match a real deliverable ID.
//
// Usage: node scripts/check-acs-coverage.mjs <plan.md> <ACs.md>

import { readFileSync } from "node:fs";
import { basename } from "node:path";

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseDeliverableIds(planText) {
  const section = planText.match(/##\s*Deliverables[\s\S]*?(?=\n##\s|\n$)/i);
  if (!section) {
    fail("Gate 1: plan.md has no '## Deliverables' section.");
  }
  const ids = new Set();
  for (const line of section[0].split("\n")) {
    // Letter-suffixed IDs are real in this repo's plans, e.g. D8b/D8c
    // (docs/plans/live-instance-operations/plan.md).
    const cell = line.match(/^\|\s*(D\d+[a-z]?)\s*\|/);
    if (cell) ids.add(cell[1]);
  }
  if (ids.size === 0) {
    fail("Gate 1: no deliverable IDs (D1, D2, ...) found in plan.md's Deliverables table.");
  }
  return ids;
}

function parseAcPlanRefs(acsText) {
  // Pre-adoption ACs tables (e.g. docs/plans/decision-runtime-deployment/
  // ACs.md) use a different column shape entirely — "ID | Acceptance
  // criterion | Executable pass condition | ...", no Plan ref at all.
  // Without this check, the row regex below would silently treat that
  // free-text second column as a Plan ref value and report a confusing
  // "invalid Plan ref" failure instead of a clear format error.
  if (!/\|\s*Plan ref\s*\|/i.test(acsText)) {
    fail(
      "Gate 1: ACs.md has no 'Plan ref' column header. This looks like a " +
        "pre-adoption ACs table (see docs/plans/decision-runtime-deployment/" +
        "ACs.md for the older ID/Acceptance-criterion/Executable-pass-" +
        "condition shape) — Gate 1 only applies to tables using the current " +
        "convention (Plan ref + Role columns; see docs/AGENTIC-WORKFLOW.md)."
    );
  }

  // Matches any "| AC-XXX-N | <plan ref> | ..." row across all AC tables.
  // Letter-suffixed AC IDs are real in this repo, e.g. AC-FN-008a/008b
  // (docs/plans/setup-profile-applier/ACs.md).
  const rows = [];
  const rowPattern = /^\|\s*(AC-[A-Z]+-\d+[a-z]?)\s*\|\s*([^|]*)\|/gm;
  let match;
  while ((match = rowPattern.exec(acsText)) !== null) {
    const acId = match[1];
    const planRef = match[2].trim();
    rows.push({ acId, planRef });
  }
  if (rows.length === 0) {
    fail("Gate 1: no AC rows (AC-XXX-N) found in ACs.md.");
  }
  return rows;
}

function main() {
  const [, , planPath, acsPath] = process.argv;
  if (!planPath || !acsPath) {
    fail("Usage: node scripts/check-acs-coverage.mjs <plan.md> <ACs.md>");
  }

  let planText, acsText;
  try {
    planText = readFileSync(planPath, "utf8");
  } catch (err) {
    fail(`Gate 1: could not read plan file "${planPath}" (${err.code ?? err.message}).`);
  }
  try {
    acsText = readFileSync(acsPath, "utf8");
  } catch (err) {
    fail(`Gate 1: could not read ACs file "${acsPath}" (${err.code ?? err.message}).`);
  }

  const deliverableIds = parseDeliverableIds(planText);
  const acRows = parseAcPlanRefs(acsText);

  const referenced = new Set();
  const orphanAcs = [];

  for (const { acId, planRef } of acRows) {
    if (planRef === "" || planRef === "—" || planRef === "-") continue; // AC-REG-style rows are allowed to have no plan ref
    const ids = planRef.split(",").map((s) => s.trim());
    // Hard-fail on ANY invalid ID in the cell, not just when every ID is
    // invalid — a mixed cell like "D1, D999" is still a real orphan
    // reference (D999) and must not pass silently just because D1 is valid.
    const invalidIds = ids.filter((id) => !deliverableIds.has(id));
    for (const id of ids) {
      if (deliverableIds.has(id)) referenced.add(id);
    }
    if (invalidIds.length > 0) orphanAcs.push({ acId, planRef, invalidIds });
  }

  const orphanDeliverables = [...deliverableIds].filter((id) => !referenced.has(id));

  if (orphanAcs.length > 0 || orphanDeliverables.length > 0) {
    const lines = [`Gate 1 FAILED: ${basename(planPath)} <-> ${basename(acsPath)} coverage mismatch.`];
    if (orphanDeliverables.length > 0) {
      lines.push(`\nDeliverables with no AC row referencing them:`);
      for (const id of orphanDeliverables) lines.push(`  - ${id}`);
    }
    if (orphanAcs.length > 0) {
      lines.push(`\nAC rows with an invalid Plan ref (matches no deliverable):`);
      for (const { acId, planRef, invalidIds } of orphanAcs) {
        lines.push(`  - ${acId} (Plan ref: "${planRef}", invalid: ${invalidIds.join(", ")})`);
      }
    }
    fail(lines.join("\n"));
  }

  process.stdout.write(
    `Gate 1 passed: ${deliverableIds.size} deliverable(s), ${acRows.length} AC row(s), 0 orphans.\n`
  );
}

main();
