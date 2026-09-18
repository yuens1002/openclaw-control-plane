// Patches the pinned Railway wrapper so POST /setup/api/run runs
// `openclaw doctor --fix` with the gateway stopped, instead of immediately
// after restarting it.
//
// OpenClaw v2026.9.x doctor takes a state-database maintenance lease and
// refuses to run while another process owns the gateway lifecycle
// ("StateDatabaseCoordinatorContentionError: another OpenClaw process owns
// gateway-lifecycle ... Stop the Gateway service ... then run openclaw doctor
// --fix"). The wrapper's run handler restarted the gateway and then called
// doctor --fix against it, so on 9.x the step always failed with exit=1 and
// never enabled configured-but-not-enabled channels/plugins -- the reason it
// exists in the handler.
//
// Stopping the gateway is not enough on its own: while doctor runs, any
// proxied request (the Control UI's polling, a WebSocket reconnect, the
// catch-all proxy) calls ensureGatewayRunning() and would respawn the
// gateway mid-doctor, recreating the contention. So the patch adds a
// maintenance hold -- runWithGatewayStopped() -- that ensureGatewayRunning()
// waits on before starting anything, and releases it before the handler's
// final restartGateway(). Requests arriving during the hold wait for it
// (seconds) instead of racing it.
//
// Requires scripts/patch-wrapper-restart-gateway.mjs to have run first:
// runWithGatewayStopped() reuses its exit-confirmed stopGatewayAndWait().
//
// Same contract as the sibling patch-wrapper-*.mjs scripts: exact literal
// anchors, each guarded to exactly one occurrence plus an already-applied
// marker, all guards evaluated before anything is written.

import fs from "node:fs";

const targetPath = process.argv[2];
if (!targetPath) {
  console.error("usage: node patch-wrapper-doctor-fix-gateway-stopped.mjs <path-to-server.js>");
  process.exit(1);
}

const replacements = [
  {
    label: "restartGateway definition (anchor for the maintenance-hold helper)",
    oldBlock: `async function restartGateway() {`,
    newBlock: `// Control-plane patch (scripts/patch-wrapper-doctor-fix-gateway-stopped.mjs):
// a maintenance hold that keeps the gateway stopped while fn() runs.
// ensureGatewayRunning() waits on it, so no proxied request can respawn the
// gateway mid-maintenance. Used for doctor --fix, which OpenClaw v2026.9.x
// refuses to run while a gateway owns the state database.
let gatewayMaintenance = null;
async function runWithGatewayStopped(fn) {
  while (gatewayMaintenance) await gatewayMaintenance;
  let release;
  gatewayMaintenance = new Promise((resolve) => {
    release = resolve;
  });
  try {
    // A start already in flight owns a process that must be stopped too.
    if (gatewayStarting) await gatewayStarting.catch(() => {});
    await stopGatewayAndWait();
    return await fn();
  } finally {
    gatewayMaintenance = null;
    release();
  }
}

async function restartGateway() {`,
    marker: `async function runWithGatewayStopped(fn) {`,
  },
  {
    label: "ensureGatewayRunning opening lines (anchor for the maintenance-hold wait)",
    oldBlock: `async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };`,
    newBlock: `async function ensureGatewayRunning() {
  while (gatewayMaintenance) await gatewayMaintenance; // see runWithGatewayStopped()
  if (!isConfigured()) return { ok: false, reason: "not configured" };`,
    marker: `while (gatewayMaintenance) await gatewayMaintenance; // see runWithGatewayStopped()`,
  },
  {
    label: "/setup/api/run restart + doctor --fix + restart sequence",
    oldBlock: `    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
    extra += \`\\n[doctor --fix] exit=\${fix.code} (output \${fix.output.length} chars)\\n\${fix.output || "(no output)"}\`;

    // Doctor may require a restart depending on changes.
    await restartGateway();`,
    newBlock: `    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    // Control-plane patch (scripts/patch-wrapper-doctor-fix-gateway-stopped.mjs):
    // doctor --fix runs with the gateway stopped and held stopped -- OpenClaw
    // v2026.9.x refuses it while a gateway owns the state database.
    const fix = await runWithGatewayStopped(() => runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"])));
    extra += \`\\n[doctor --fix] exit=\${fix.code} (output \${fix.output.length} chars)\\n\${fix.output || "(no output)"}\`;

    // Start the gateway on the onboarded, doctor-fixed config. The hold left
    // it stopped, so this is a plain start -- not restartGateway(), which
    // would kill a start a request waiting on the hold has just begun.
    await ensureGatewayRunning();`,
    marker: `const fix = await runWithGatewayStopped(`,
  },
];

const content = fs.readFileSync(targetPath, "utf8");

let failed = false;
for (const { label, oldBlock, marker } of replacements) {
  const alreadyApplied = content.split(marker).length - 1;
  if (alreadyApplied !== 0) {
    failed = true;
    console.error(
      `the ${label} replacement is already present in ${targetPath} (found ${alreadyApplied} occurrence(s) of the injected block); ` +
        "refusing to apply the doctor-fix patch twice.",
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
if (!content.includes("async function stopGatewayAndWait() {")) {
  failed = true;
  console.error(
    `stopGatewayAndWait() is not defined in ${targetPath}; run scripts/patch-wrapper-restart-gateway.mjs first.`,
  );
}
if (failed) process.exit(1);

let patched = content;
for (const { oldBlock, newBlock } of replacements) {
  // Replacer function: a plain string replacement would interpret `$`-sequences in newBlock.
  patched = patched.replace(oldBlock, () => newBlock);
}
fs.writeFileSync(targetPath, patched);
console.log(`patched ${targetPath} to run doctor --fix with the gateway stopped (runWithGatewayStopped)`);
