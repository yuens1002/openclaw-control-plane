// Patches the pinned Railway wrapper's restartGateway() to wait for the
// child gateway process's actual `exit` event (escalating to SIGKILL after a
// timeout) instead of a flat 750ms sleep with no exit confirmation. See the
// Dockerfile comment above the RUN step that invokes this script for the
// full rationale and links to the upstream/tracking issues.
//
// A real script (not an inline `sed` one-liner) is used here specifically
// because this is a multi-line structural replacement -- a `sed` pattern
// spanning several lines is fragile to get exactly right and hard to review;
// an exact literal string match via `String.prototype.replace` is not.

import fs from "node:fs";

const targetPath = process.argv[2];
if (!targetPath) {
  console.error("usage: node patch-wrapper-restart-gateway.mjs <path-to-server.js>");
  process.exit(1);
}

const oldBlock = `    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);`;

const newBlock = `    const proc = gatewayProc;
    try {
      proc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Wait for the process to actually exit (escalating to SIGKILL after a timeout) before considering the restart complete.
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
    }`;

const content = fs.readFileSync(targetPath, "utf8");
const occurrences = content.split(oldBlock).length - 1;

if (occurrences !== 1) {
  console.error(
    `expected exactly 1 occurrence of the target restartGateway() block in ${targetPath}, found ${occurrences}. ` +
      "The pinned wrapper's source may have changed -- re-verify this patch against the new source before proceeding."
  );
  process.exit(1);
}

fs.writeFileSync(targetPath, content.replace(oldBlock, newBlock));
console.log(`patched restartGateway() in ${targetPath}`);
