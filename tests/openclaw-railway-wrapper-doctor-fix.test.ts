import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// scripts/patch-wrapper-doctor-fix-gateway-stopped.mjs, exercised through its
// real surface (`node <script> <server.js>`) against a fixture carrying the
// pinned wrapper's gateway lifecycle functions and /setup/api/run doctor
// sequence exactly as they stand after patch-wrapper-restart-gateway.mjs
// (copied from the built image's src/server.js). The run-handler excerpt is
// wrapped in applySetupRunTail() so it can be called directly. The patched
// code is then executed against a fake gateway process, so the assertions
// cover ordering -- whether doctor --fix ever runs beside a live gateway --
// not just the presence of injected text.

const patchPath = fileURLToPath(new URL("../scripts/patch-wrapper-doctor-fix-gateway-stopped.mjs", import.meta.url));

const WRAPPER_LIFECYCLE_FIXTURE = `let gatewayProc = null;
let gatewayStarting = null;
let lastGatewayError = null;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function startGateway() {
  if (gatewayProc) return;
  gatewayProc = spawnGateway();
  gatewayProc.on("exit", () => {
    gatewayProc = null;
  });
}

async function ensureGatewayRunning() {
  if (!isConfigured()) return { ok: false, reason: "not configured" };
  if (gatewayProc) return { ok: true };
  if (!gatewayStarting) {
    gatewayStarting = (async () => {
      try {
        lastGatewayError = null;
        await startGateway();
        const ready = await waitForGatewayReady({ timeoutMs: 20_000 });
        if (!ready) {
          throw new Error("Gateway did not become ready in time");
        }
      } catch (err) {
        const msg = \`[gateway] start failure: \${String(err)}\`;
        lastGatewayError = msg;
        // Collect extra diagnostics to help users file issues.
        await runDoctorBestEffort();
        throw err;
      }
    })().finally(() => {
      gatewayStarting = null;
    });
  }
  await gatewayStarting;
  return { ok: true };
}

async function stopGatewayAndWait() {
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
    const stillRunning = await Promise.race([exited.then(() => false), sleep(5000).then(() => true)]);
    if (stillRunning) {
      throw new Error("gateway process did not exit within 5s of SIGKILL; refusing to start a second gateway");
    }
  }
  gatewayProc = null;
}

async function restartGateway() {
  if (gatewayProc) {
    await stopGatewayAndWait();
  }
  return ensureGatewayRunning();
}

async function applySetupRunTail() {
  let extra = "";
    // Apply changes immediately.
    await restartGateway();

    // Ensure OpenClaw applies any "configured but not enabled" channel/plugin changes.
    // This makes Telegram/Discord pairing issues much less "silent".
    const fix = await runCmd(OPENCLAW_NODE, clawArgs(["doctor", "--fix"]));
    extra += \`\\n[doctor --fix] exit=\${fix.code} (output \${fix.output.length} chars)\\n\${fix.output || "(no output)"}\`;

    // Doctor may require a restart depending on changes.
    await restartGateway();
  return extra;
}
`;

class FakeGatewayProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: string | null = null;
  constructor(private readonly log: string[]) {
    super();
  }
  kill(signal: string): void {
    this.log.push(`kill:${signal}`);
    setTimeout(() => {
      this.signalCode = signal;
      this.log.push("exit");
      this.emit("exit", null, signal);
    }, 5);
  }
}

interface Harness {
  log: string[];
  live: () => number;
  api: {
    ensureGatewayRunning(): Promise<{ ok: boolean }>;
    applySetupRunTail(): Promise<string>;
  };
  /** Resolves the in-flight doctor --fix run; set once doctor starts. */
  finishDoctor?: () => void;
  doctorStarted: Promise<void>;
}

function loadHarness(source: string): Harness {
  const log: string[] = [];
  const processes: FakeGatewayProcess[] = [];
  let markDoctorStarted!: () => void;
  const harness = {
    log,
    live: () => processes.filter((proc) => proc.exitCode === null && proc.signalCode === null).length,
    doctorStarted: new Promise<void>((resolve) => {
      markDoctorStarted = resolve;
    })
  } as Harness;
  const context = vm.createContext({
    setTimeout,
    isConfigured: () => true,
    waitForGatewayReady: async () => true,
    runDoctorBestEffort: async () => {},
    OPENCLAW_NODE: "node",
    clawArgs: (args: string[]) => args,
    spawnGateway: () => {
      const proc = new FakeGatewayProcess(log);
      processes.push(proc);
      log.push("spawn");
      return proc;
    },
    runCmd: (_node: string, args: string[]) => {
      log.push(`doctor-start live=${harness.live()}`);
      return new Promise((resolve) => {
        harness.finishDoctor = () => {
          log.push(`doctor-end live=${harness.live()}`);
          resolve({ code: 0, output: `ran ${args.join(" ")}` });
        };
        markDoctorStarted();
      });
    }
  });
  harness.api = vm.runInContext(`${source}\n;({ ensureGatewayRunning, applySetupRunTail });`, context) as Harness["api"];
  return harness;
}

describe("patch-wrapper-doctor-fix-gateway-stopped", () => {
  let dir: string;
  let serverPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wrapper-doctor-fix-"));
    serverPath = join(dir, "server.js");
    writeFileSync(serverPath, WRAPPER_LIFECYCLE_FIXTURE);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const runPatch = () => spawnSync(process.execPath, [patchPath, serverPath], { encoding: "utf8" });

  it("applies once, keeps valid syntax, and refuses a second run", () => {
    const first = runPatch();
    expect(first.status, first.stderr).toBe(0);
    const check = spawnSync(process.execPath, ["--check", serverPath], { encoding: "utf8" });
    expect(check.status, check.stderr).toBe(0);

    const second = runPatch();
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain("refusing to apply the doctor-fix patch twice");
  });

  it("fails without writing when patch-wrapper-restart-gateway has not run", () => {
    const unpatchedRestart = WRAPPER_LIFECYCLE_FIXTURE.replace(
      "async function stopGatewayAndWait() {",
      "async function legacyStopGateway() {"
    );
    writeFileSync(serverPath, unpatchedRestart);
    const result = runPatch();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("run scripts/patch-wrapper-restart-gateway.mjs first");
    expect(readFileSync(serverPath, "utf8")).toBe(unpatchedRestart);
  });

  it("fails without writing when the doctor sequence anchor is missing", () => {
    const withoutAnchor = WRAPPER_LIFECYCLE_FIXTURE.replace("    // Apply changes immediately.\n", "");
    writeFileSync(serverPath, withoutAnchor);
    const result = runPatch();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("found 0");
    expect(readFileSync(serverPath, "utf8")).toBe(withoutAnchor);
  });

  it("without a target path prints usage and exits non-zero", () => {
    const result = spawnSync(process.execPath, [patchPath], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("usage:");
  });

  it("reproduces the defect before the patch: doctor --fix runs beside a live gateway", async () => {
    const harness = loadHarness(WRAPPER_LIFECYCLE_FIXTURE);
    const run = harness.api.applySetupRunTail();
    await harness.doctorStarted;
    harness.finishDoctor?.();
    await run;
    expect(harness.log).toContain("doctor-start live=1");
  });

  it("runs doctor --fix with no gateway process, then starts exactly one", async () => {
    expect(runPatch().status).toBe(0);
    const harness = loadHarness(readFileSync(serverPath, "utf8"));
    await harness.api.ensureGatewayRunning(); // the gateway is up before setup's tail runs

    const run = harness.api.applySetupRunTail();
    await harness.doctorStarted;
    harness.finishDoctor?.();
    const output = await run;

    expect(harness.log).toEqual(["spawn", "kill:SIGTERM", "exit", "doctor-start live=0", "doctor-end live=0", "spawn"]);
    expect(harness.live()).toBe(1);
    expect(output).toContain("[doctor --fix] exit=0");
  });

  it("holds concurrent gateway starts until doctor --fix finishes", async () => {
    expect(runPatch().status).toBe(0);
    const harness = loadHarness(readFileSync(serverPath, "utf8"));
    await harness.api.ensureGatewayRunning();

    const run = harness.api.applySetupRunTail();
    await harness.doctorStarted;
    // A proxied request (Control UI poll, WebSocket reconnect) mid-doctor.
    const concurrent = harness.api.ensureGatewayRunning();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(harness.live()).toBe(0);

    harness.finishDoctor?.();
    await Promise.all([run, concurrent]);
    expect(harness.log.filter((entry) => entry.startsWith("doctor-")).every((entry) => entry.endsWith("live=0"))).toBe(true);
    // One spawn before setup, one after doctor -- the waiting request and the
    // handler share the post-doctor start instead of restarting each other.
    expect(harness.log.filter((entry) => entry === "spawn")).toHaveLength(2);
    expect(harness.live()).toBe(1);
  });
});
