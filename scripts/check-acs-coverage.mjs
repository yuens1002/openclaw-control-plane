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
    const cell = line.match(/^\|\s*(D\d+)\s*\|/);
    if (cell) ids.add(cell[1]);
  }
  if (ids.size === 0) {
    fail("Gate 1: no deliverable IDs (D1, D2, ...) found in plan.md's Deliverables table.");
  }
  return ids;
}

function parseAcPlanRefs(acsText) {
  // Matches any "| AC-XXX-N | <plan ref> | ..." row across all AC tables.
  const rows = [];
  const rowPattern = /^\|\s*(AC-[A-Z]+-\d+)\s*\|\s*([^|]*)\|/gm;
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

  const planText = readFileSync(planPath, "utf8");
  const acsText = readFileSync(acsPath, "utf8");

  const deliverableIds = parseDeliverableIds(planText);
  const acRows = parseAcPlanRefs(acsText);

  const referenced = new Set();
  const orphanAcs = [];

  for (const { acId, planRef } of acRows) {
    if (planRef === "" || planRef === "—" || planRef === "-") continue; // AC-REG-style rows are allowed to have no plan ref
    const ids = planRef.split(",").map((s) => s.trim());
    let anyMatched = false;
    for (const id of ids) {
      if (deliverableIds.has(id)) {
        referenced.add(id);
        anyMatched = true;
      }
    }
    if (!anyMatched) orphanAcs.push({ acId, planRef });
  }

  const orphanDeliverables = [...deliverableIds].filter((id) => !referenced.has(id));

  if (orphanAcs.length > 0 || orphanDeliverables.length > 0) {
    const lines = [`Gate 1 FAILED: ${basename(planPath)} <-> ${basename(acsPath)} coverage mismatch.`];
    if (orphanDeliverables.length > 0) {
      lines.push(`\nDeliverables with no AC row referencing them:`);
      for (const id of orphanDeliverables) lines.push(`  - ${id}`);
    }
    if (orphanAcs.length > 0) {
      lines.push(`\nAC rows whose Plan ref matches no deliverable:`);
      for (const { acId, planRef } of orphanAcs) lines.push(`  - ${acId} (Plan ref: "${planRef}")`);
    }
    fail(lines.join("\n"));
  }

  process.stdout.write(
    `Gate 1 passed: ${deliverableIds.size} deliverable(s), ${acRows.length} AC row(s), 0 orphans.\n`
  );
}

main();
