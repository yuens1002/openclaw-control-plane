// Patches the pinned Railway wrapper so every "stop the gateway before doing
// X" site waits for the child gateway process's actual `exit` event
// (escalating to SIGKILL after a timeout) instead of a flat 750ms sleep with
// no exit confirmation. One helper, `stopGatewayAndWait()`, is defined once
// above restartGateway(); restartGateway() and the /setup/import handler both
// call it. See the Dockerfile comment above the RUN step that invokes this
// script for the full rationale and links to the upstream/tracking issues.
//
// A real script (not an inline `sed` one-liner) is used here specifically
// because these are multi-line structural replacements -- a `sed` pattern
// spanning several lines is fragile to get exactly right and hard to review;
// an exact literal string match via `String.prototype.replace` is not.
//
// Three independent exact-block replacements, each with its own
// exactly-one-occurrence guard, all guards evaluated before anything is
// written: a template bump that moves any one site fails the build rather
// than silently leaving that site racing.

import fs from "node:fs";

const targetPath = process.argv[2];
if (!targetPath) {
  console.error("usage: node patch-wrapper-restart-gateway.mjs <path-to-server.js>");
  process.exit(1);
}

// The helper captures a local `proc` reference before signalling because the
// wrapper's own `exit` handler nulls the shared `gatewayProc` variable; a
// fast-exiting process would otherwise leave this code dereferencing null.
const stopGatewayAndWaitDefinition = `async function stopGatewayAndWait() {
  const proc = gatewayProc;
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // ignore
  }
  // Wait for the process to actually exit (escalating to SIGKILL after a timeout) before considering the gateway slot free.
  const alreadyExited = proc.exitCode !== null || proc.signalCode !== null;
  const exited = alreadyExited ? Promise.resolve() : new Promise((resolve) => proc.once("exit", () => resolve()));
  const timedOut = alreadyExited ? false : await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
  if (timedOut) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignore
    }
    await exited;
  }
  gatewayProc = null;
}`;

const replacements = [
  {
    label: "restartGateway() declaration line (anchor for the stopGatewayAndWait() definition)",
    oldBlock: `async function restartGateway() {`,
    newBlock: `${stopGatewayAndWaitDefinition}

async function restartGateway() {`,
  },
  {
    label: "restartGateway() inline kill/sleep(750)/null block",
    oldBlock: `  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();`,
    newBlock: `  if (gatewayProc) {
    await stopGatewayAndWait();
  }
  return ensureGatewayRunning();`,
  },
  {
    label: "/setup/import handler inline kill/sleep(750)/null block",
    oldBlock: `    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }`,
    newBlock: `    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      await stopGatewayAndWait();
    }`,
  },
];

const content = fs.readFileSync(targetPath, "utf8");

let failed = false;
for (const { label, oldBlock, newBlock } of replacements) {
  // The declaration-line anchor survives as a suffix of its own replacement,
  // so an anchor count alone cannot detect a second application: also
  // require the injected block to be absent.
  const alreadyApplied = content.split(newBlock).length - 1;
  if (alreadyApplied !== 0) {
    failed = true;
    console.error(
      `the ${label} replacement is already present in ${targetPath} (found ${alreadyApplied} occurrence(s) of the injected block); ` +
        "refusing to apply the restart-gateway patch twice.",
    );
    continue;
  }
  const occurrences = content.split(oldBlock).length - 1;
  if (occurrences !== 1) {
    failed = true;
    console.error(
      `expected exactly 1 occurrence of the ${label} in ${targetPath}, found ${occurrences}. ` +
        "The pinned wrapper's source may have changed -- re-verify this patch against the current source before proceeding.",
    );
  }
}
if (failed) process.exit(1);

let patched = content;
for (const { oldBlock, newBlock } of replacements) {
  // Replacer function: a plain string replacement would interpret `$`-sequences in newBlock.
  patched = patched.replace(oldBlock, () => newBlock);
}
fs.writeFileSync(targetPath, patched);
console.log(`patched restartGateway() and /setup/import to share stopGatewayAndWait() in ${targetPath}`);
