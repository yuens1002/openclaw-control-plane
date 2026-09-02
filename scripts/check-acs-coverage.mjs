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
  // Match every "## Deliverables" section, not just the first — a plan with
  // two such sections (e.g. a multi-session plan appending a second batch)
  // would otherwise have its second section silently ignored. The `$`
  // alternative (not `\n$`) also matches when the section is the file's
  // last content and the file has no trailing newline.
  const sections = planText.match(/##\s*Deliverables[\s\S]*?(?=\n##\s|$)/gi);
  if (!sections) {
    fail("Gate 1: plan.md has no '## Deliverables' section.");
  }
  if (sections.length > 1) {
    fail(
      `Gate 1: plan.md has ${sections.length} '## Deliverables' sections — expected exactly one. ` +
        "Merge them into a single section so deliverable coverage can be checked unambiguously."
    );
  }
  const ids = new Set();
  for (const line of sections[0].split("\n")) {
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

// Locates the 0-indexed column position of the "Plan ref" header in a real
// markdown table — a header row immediately followed by a `| --- | --- |`
// separator row. A plain substring/regex scan for "Plan ref" anywhere in the
// file (the prior approach) false-positives on the ACs-template legend table
// that documents what "Plan ref" means (see docs/plans/*/ACs.md's "Column |
// Filled by | When" table, which has its own literal "| Plan ref | ... |"
// row) — that row is prose about the convention, not the AC table's own
// header, so it must not satisfy this check.
function findPlanRefColumnIndex(acsText) {
  const lines = acsText.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const header = lines[i];
    const separator = lines[i + 1];
    if (!/^\|.*\|\s*$/.test(header)) continue;
    if (!/^\|.*\|\s*$/.test(separator)) continue;
    const separatorCells = separator.split("|").slice(1, -1);
    if (separatorCells.length === 0 || !separatorCells.every((c) => /^\s*:?-+:?\s*$/.test(c))) continue;
    const cells = header.split("|").slice(1, -1).map((c) => c.trim());
    const idx = cells.findIndex((c) => /^plan ref$/i.test(c));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseAcPlanRefs(acsText) {
  // Pre-adoption ACs tables (e.g. docs/plans/durable-runtime-state/
  // ACs.md) use a different column shape entirely — "ID | Acceptance
  // criterion | Executable pass condition | ...", no Plan ref at all.
  // Without this check, the row regex below would silently treat that
  // free-text second column as a Plan ref value and report a confusing
  // "invalid Plan ref" failure instead of a clear format error.
  const planRefIndex = findPlanRefColumnIndex(acsText);
  if (planRefIndex === -1) {
    fail(
      "Gate 1: ACs.md has no 'Plan ref' table column header (a real markdown " +
        "table header row immediately followed by a '| --- |' separator row). " +
        "This looks like a pre-adoption ACs table (see docs/plans/durable-runtime-" +
        "state/ACs.md for the older ID/Acceptance-criterion/Executable-pass-" +
        "condition shape) — Gate 1 only applies to tables using the current " +
        "convention (Plan ref + Role columns; see docs/AGENTIC-WORKFLOW.md)."
    );
  }

  // The row parser below assumes the AC id is always the table's first
  // column (true of every real table in this repo) and reads Plan ref from
  // the rest of the row at `planRefIndex - 1`. If Plan ref were itself the
  // first column (index 0), that offset goes negative and every row would
  // silently read as blank instead of failing loudly — reject that layout
  // explicitly rather than mis-parse it.
  if (planRefIndex === 0) {
    fail(
      "Gate 1: 'Plan ref' is the table's first column, but Gate 1 assumes the " +
        "AC id (AC-XXX-N) is always column 1. Reorder the table so the AC id " +
        "comes first."
    );
  }

  // Matches any "| AC-XXX-N | ...rest of row... |" row across all AC
  // tables, then splits the rest on "|" to read the cell at planRefIndex —
  // this assumes the AC id is always the table's first column (true of
  // every real table in this repo) but no longer assumes Plan ref is always
  // the second column, so a table with Plan ref moved further right (or an
  // extra column inserted before it) is still read correctly.
  // Letter-suffixed AC IDs are real in this repo, e.g. AC-FN-008a/008b
  // (docs/plans/setup-profile-applier/ACs.md).
  const rows = [];
  const rowPattern = /^\|\s*(AC-[A-Z]+-\d+[a-z]?)\s*\|(.*)\|\s*$/gm;
  let match;
  while ((match = rowPattern.exec(acsText)) !== null) {
    const acId = match[1];
    const restCells = match[2].split("|").map((c) => c.trim());
    const planRef = (restCells[planRefIndex - 1] ?? "").trim();
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
    const isBlank = planRef === "" || planRef === "—" || planRef === "-";
    if (isBlank) {
      // Only AC-REG-*/AC-REGRESSION-* rows (whole-suite regression checks
      // with no single owning deliverable) may omit a Plan ref. Both
      // prefixes are real, current-convention usage in this repo (compare
      // docs/plans/mcp-workload-jwt-auth/ACs.md's AC-REGRESSION-001, a fully
      // Plan-ref/Role-conforming file, against the more common AC-REG-001
      // spelling elsewhere). Any other prefix with a blank cell is a real
      // traceability gap, not a legitimate exception — catching it here is
      // the point of this check.
      if (/^AC-REG(?:RESSION)?-/i.test(acId)) continue;
      orphanAcs.push({ acId, planRef: "(blank)", invalidIds: ["(missing Plan ref)"] });
      continue;
    }
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
