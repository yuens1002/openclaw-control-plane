import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as tar from "tar";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Issue #73 (wrapper-scoped-export-and-import-restart), deliverable D4.
//
// Three units under test, all exercised through their real surface:
//   - scripts/wrapper-state-export.mjs  -- imported as a module (it is
//     dependency-free ESM; the Dockerfile copies it verbatim into the
//     wrapper image) and run against a temp STATE_DIR fixture.
//   - scripts/patch-wrapper-scoped-export.mjs and
//     scripts/patch-wrapper-restart-gateway.mjs -- run as child processes
//     (their only interface is `node <script> <path-to-server.js>`) against
//     a synthetic server.js fixture that carries the pinned wrapper's exact
//     anchor lines, including all four `await sleep(750);` sites.
//
// The .mjs module is loaded via a dynamic import of a computed file:// URL
// rather than a static specifier: tests/tsconfig.json has rootDir "." and no
// allowJs, so a static `../scripts/*.mjs` import cannot be typechecked by
// `tsc -b`. The shape is pinned locally by StateExportModule instead.
//
// That load goes through Node's own loader, not vite-node's. Vite 5.4's
// builtin list predates node:sqlite, so an `import("node:sqlite")` in any
// file vite-node inlines (this test, and scripts/wrapper-state-export.mjs,
// which lives outside node_modules) is rewritten to resolve a package named
// "sqlite" and rejects with "Failed to load url sqlite". `createRequire`
// (Node >= 22.12 supports require() of a synchronous ESM module, which this
// one is) hands the file to Node directly, so its inner dynamic import stays
// native too -- the same code path the wrapper image runs. The node:sqlite
// probe uses `process.getBuiltinModule` for the same reason. The
// alternative, `server.deps.external` in vitest.config.ts, would work as
// well but is a repo-wide setting for a single-file need.

const nativeRequire = createRequire(import.meta.url);
const getBuiltinModule = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;

const scriptsDir = fileURLToPath(new URL("../scripts/", import.meta.url));
const stateExportModulePath = join(scriptsDir, "wrapper-state-export.mjs");
const scopedExportPatchPath = join(scriptsDir, "patch-wrapper-scoped-export.mjs");
const restartGatewayPatchPath = join(scriptsDir, "patch-wrapper-restart-gateway.mjs");

type DirentLike = { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };

interface StateExportModule {
  STATE_EXPORT_INCLUDE: readonly string[];
  STATE_EXPORT_EXCLUDE_SEGMENTS: readonly string[];
  STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS: readonly string[];
  STATE_EXPORT_MAX_BYTES_ENV: string;
  STATE_EXPORT_ARCHIVE_ROOT: string;
  filterStateEntry(relativePath: string, dirent: DirentLike): boolean;
  snapshotSqlite(sourcePath: string, targetPath: string): Promise<void>;
  buildStateExportTree(options: { stateDir: string; targetRoot: string; maxBytes?: number }): Promise<{
    files: string[];
    bytes: number;
  }>;
}

// Minimal node:sqlite surface used by the fixture builder and the assertions.
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
  close(): void;
}
interface SqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

const stateExport = nativeRequire(stateExportModulePath) as StateExportModule;

// node:sqlite ships unflagged from Node 22.13; older runtimes reject
// `import("node:sqlite")` (and, below 22.3, lack getBuiltinModule entirely).
// The fixture-tree and snapshot tests need it (the module itself refuses to
// export a *.sqlite without it), so they skip -- visibly, not silently --
// when it is missing. filterStateEntry and the patch-script tests do not
// depend on it and always run.
function probeNodeSqlite(): SqliteModule | null {
  if (typeof getBuiltinModule !== "function") return null;
  try {
    const loaded = getBuiltinModule.call(process, "node:sqlite") as SqliteModule | undefined;
    return loaded && typeof loaded.DatabaseSync === "function" ? loaded : null;
  } catch {
    return null;
  }
}
const sqliteModule = probeNodeSqlite();
const sqliteAvailable = sqliteModule !== null;

const fileDirent: DirentLike = { isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
const dirDirent: DirentLike = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
const symlinkDirent: DirentLike = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => true };
const socketDirent: DirentLike = { isFile: () => false, isDirectory: () => false, isSymbolicLink: () => false };

const SLEEP_750 = "await sleep(750);";
const countOccurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

function segmentsOf(archivePath: string): string[] {
  return archivePath.split("/").filter((segment) => segment !== "");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}

/** Writes `content` at `stateDir/<relativePath>` (POSIX separators), creating parents. */
function writeFixtureFile(stateDir: string, relativePath: string, content: string | Buffer): void {
  const target = join(stateDir, ...relativePath.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}

/** Runs one patch script as a child process against `serverJsPath`, mirroring the Dockerfile RUN step. */
function runPatchScript(scriptPath: string, serverJsPath: string) {
  const result = spawnSync(process.execPath, [scriptPath, serverJsPath], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** Mirrors the Dockerfile's `node --check src/server.js` assertion. */
function nodeCheck(serverJsPath: string): number | null {
  return spawnSync(process.execPath, ["--check", serverJsPath], { encoding: "utf8" }).status;
}

// --- Synthetic server.js fixture ---------------------------------------------
//
// Every anchor and every replaced block below is byte-identical to the pinned
// wrapper (vignesh07/clawdbot-railway-template @ OPENCLAW_TEMPLATE_REF): the
// patch scripts match exact literal blocks, so a fixture that paraphrased
// them would not exercise the same match. The surrounding scaffolding is the
// minimum that keeps the file valid for `node --check`.
//
// Four `await sleep(750);` sites, in the same order as the real file:
//   1. restartGateway()            -- replaced by D3
//   2. setup-cli "gateway.stop"    -- unrelated, must survive
//   3. POST /setup/api/reset handler -- unrelated, must survive (its inline
//      comment mentions "onboard"; the block lives in the reset route)
//   4. /setup/import handler       -- replaced by D3

const RESTART_GATEWAY_ORIGINAL = `async function restartGateway() {
  if (gatewayProc) {
    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
  }
  return ensureGatewayRunning();
}`;

const GATEWAY_STOP_BLOCK_UNRELATED = `    if (cmd === "gateway.stop") {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
      return res.json({ ok: true, output: "Gateway stopped (wrapper-managed).\\n" });
    }`;

const RESET_STOP_BLOCK_UNRELATED = `    // Stop gateway to avoid running gateway + onboard concurrently on small Railway instances.
    try {
      if (gatewayProc) {
        try { gatewayProc.kill("SIGTERM"); } catch {}
        await sleep(750);
        gatewayProc = null;
      }
    } catch {
      // ignore
    }`;

const IMPORT_STOP_BLOCK_ORIGINAL = `    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
    }`;

const EXPORT_HANDLER_OPENING_LINE = `app.get("/setup/export", requireSetupAuth, async (_req, res) => {`;

// The unscoped export body that must remain byte-identical after the delegate
// is prefixed (AC-FN-008: the delegate is a prefix, not a rewrite).
const EXPORT_HANDLER_BODY_ORIGINAL = `  try {
    res.setHeader("content-type", "application/gzip");
    res.setHeader("content-disposition", \`attachment; filename="openclaw-backup.tar.gz"\`);
    tar.c({ gzip: true, portable: true, noMtime: true, cwd: "/data" }, [".openclaw"]).pipe(res);
  } catch (err) {
    res.status(500).type("text/plain").send(String(err));
  }
});`;

const SYNTHETIC_SERVER_JS = `import * as tar from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const STATE_DIR = "/data/.openclaw";
const WORKSPACE_DIR = "/data/workspace";
let gatewayProc = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function ensureGatewayRunning() {
  return { ok: true };
}
function requireSetupAuth(_req, _res, next) {
  next();
}
const app = { get() {}, post() {} };

${RESTART_GATEWAY_ORIGINAL}

async function runSetupCommand(cmd, res) {
  try {
    if (cmd === "gateway.restart") {
      await restartGateway();
      return res.json({ ok: true, output: "Gateway restarted (wrapper-managed).\\n" });
    }
${GATEWAY_STOP_BLOCK_UNRELATED}
  } catch (err) {
    return res.status(500).send(String(err));
  }
}

async function runOnboard(res) {
  try {
${RESET_STOP_BLOCK_UNRELATED}
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).send(String(err));
  }
}

${EXPORT_HANDLER_OPENING_LINE}
${EXPORT_HANDLER_BODY_ORIGINAL}

function isUnderDir(p, root) {
  const rel = path.relative(root, p);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Import a backup created by /setup/export.
// This is intentionally limited to restoring into /data to avoid overwriting arbitrary host paths.
app.post("/setup/import", requireSetupAuth, async (req, res) => {
  try {
    const dataRoot = "/data";
    if (!isUnderDir(STATE_DIR, dataRoot) || !isUnderDir(WORKSPACE_DIR, dataRoot)) {
      return res.status(400).type("text/plain").send("Import is only supported under /data\\n");
    }

${IMPORT_STOP_BLOCK_ORIGINAL}

    await restartGateway();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).type("text/plain").send(String(err));
  }
});

export { app, runSetupCommand, runOnboard, tar, fs, os };
`;

// --- STATE_DIR fixture -------------------------------------------------------

// Relative paths (POSIX) that filterStateEntry must accept; every include root
// is represented, plus the agents/<id>/agent/ allow-listed basenames.
const EXPECTED_INCLUDED = [
  "openclaw.json",
  "exec-approvals.json",
  "credentials/oauth.json",
  "devices/paired.json",
  "cron/jobs.json",
  "identity/device.json",
  "memory/notes.md",
  "state/openclaw.sqlite",
  "agents/main/agent/openclaw-agent.sqlite",
  "agents/main/agent/models.json",
  "agents/main/agent/auth-profiles.json"
];

// Decoys named by AC-TST-001, plus the symlink added at fixture build time.
const DECOYS = [
  "bin/big.bin",
  "lib/x",
  "agents/main/sessions/s.jsonl",
  "agents/main/agent/plugins/p.js",
  "openclaw.json.bak-1",
  "state/openclaw.sqlite-wal",
  // A DIRECTORY whose basename matches an exclude pattern, under an include
  // root: the pattern must stop the walk at the directory, not just at files.
  "credentials/old.bak-1/secret.txt"
];

const SNAPSHOT_ROWS = [
  { id: 1, body: "row one, lives in the WAL" },
  { id: 2, body: "row two, also un-checkpointed" },
  { id: 3, body: "row three" }
];

interface StateDirFixture {
  root: string;
  stateDir: string;
  symlinkRelativePath: string;
  /** Held open so the WAL stays un-checkpointed for the whole fixture lifetime. */
  walWriter: SqliteDatabase | null;
}

/**
 * Creates a STATE_DIR with every include root, every AC-TST-001 decoy, a
 * WAL-mode SQLite whose rows are deliberately left in the -wal file, and a
 * symlink. On win32 a plain file symlink needs elevated privileges while a
 * directory junction does not, so the symlink is a junction there; either
 * way lstat reports isSymbolicLink() and the walk must skip it.
 */
function buildStateDirFixture(sqlite: SqliteModule | null): StateDirFixture {
  const root = mkdtempSync(join(tmpdir(), "wrapper-state-export-test-"));
  const stateDir = join(root, "state-dir");
  mkdirSync(stateDir);

  writeFixtureFile(stateDir, "openclaw.json", JSON.stringify({ gateway: { port: 18789 } }));
  writeFixtureFile(stateDir, "exec-approvals.json", JSON.stringify({ approvals: [] }));
  writeFixtureFile(stateDir, "credentials/oauth.json", JSON.stringify({ token: "fixture-not-a-secret" }));
  writeFixtureFile(stateDir, "devices/paired.json", JSON.stringify({ devices: [] }));
  writeFixtureFile(stateDir, "cron/jobs.json", JSON.stringify({ jobs: [] }));
  writeFixtureFile(stateDir, "identity/device.json", JSON.stringify({ id: "fixture-device" }));
  writeFixtureFile(stateDir, "memory/notes.md", "# fixture memory\n");
  writeFixtureFile(stateDir, "agents/main/agent/models.json", JSON.stringify({ models: [] }));
  writeFixtureFile(stateDir, "agents/main/agent/auth-profiles.json", JSON.stringify({ profiles: [] }));

  // Decoys: bulk directories and wrapper leftovers that must never be exported.
  writeFixtureFile(stateDir, "bin/big.bin", Buffer.alloc(64 * 1024, 0xab));
  writeFixtureFile(stateDir, "lib/x", "library payload\n");
  writeFixtureFile(stateDir, "agents/main/sessions/s.jsonl", '{"role":"user"}\n');
  writeFixtureFile(stateDir, "agents/main/agent/plugins/p.js", "export default {};\n");
  writeFixtureFile(stateDir, "openclaw.json.bak-1", "{}\n");
  writeFixtureFile(stateDir, "credentials/old.bak-1/secret.txt", "must never be exported\n");

  let walWriter: SqliteDatabase | null = null;
  if (sqlite) {
    mkdirSync(join(stateDir, "state"));
    walWriter = new sqlite.DatabaseSync(join(stateDir, "state", "openclaw.sqlite"));
    walWriter.exec("PRAGMA journal_mode=WAL");
    // Keep every insert in the -wal file: no auto-checkpoint, and the writer
    // connection stays open (closing it would checkpoint and delete the WAL).
    walWriter.exec("PRAGMA wal_autocheckpoint=0");
    walWriter.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
    for (const row of SNAPSHOT_ROWS) {
      walWriter.exec(`INSERT INTO notes (id, body) VALUES (${row.id}, '${row.body}')`);
    }
    const agentDb = new sqlite.DatabaseSync(join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite"));
    agentDb.exec("CREATE TABLE runs (id INTEGER PRIMARY KEY)");
    agentDb.exec("INSERT INTO runs (id) VALUES (1)");
    agentDb.close();
  } else {
    // Placeholders so the include-root inventory is still complete when the
    // snapshot tests are skipped; the -wal decoy is a plain file here.
    writeFixtureFile(stateDir, "state/openclaw.sqlite", "");
    writeFixtureFile(stateDir, "state/openclaw.sqlite-wal", "");
    writeFixtureFile(stateDir, "agents/main/agent/openclaw-agent.sqlite", "");
  }

  let symlinkRelativePath: string;
  if (process.platform === "win32") {
    symlinkRelativePath = "credentials/linked-memory";
    symlinkSync(join(stateDir, "memory"), join(stateDir, "credentials", "linked-memory"), "junction");
  } else {
    symlinkRelativePath = "credentials/linked-openclaw.json";
    symlinkSync(join("..", "openclaw.json"), join(stateDir, "credentials", "linked-openclaw.json"));
  }

  return { root, stateDir, symlinkRelativePath, walWriter };
}

function destroyStateDirFixture(fixture: StateDirFixture): void {
  fixture.walWriter?.close();
  rmSync(fixture.root, { recursive: true, force: true });
}

/** Lists every regular file under `dir`, as archive-relative POSIX paths rooted at `prefix`. */
function listTreeFiles(dir: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isDirectory()) files.push(...listTreeFiles(join(dir, dirent.name), relative));
    else files.push(relative);
  }
  return files.sort();
}

describe("wrapper-state-export: filterStateEntry", () => {
  it("exports the closed include/exclude lists the ACs name", () => {
    expect(stateExport.STATE_EXPORT_INCLUDE).toContain("openclaw.json");
    expect(stateExport.STATE_EXPORT_INCLUDE).toContain("credentials");
    expect(stateExport.STATE_EXPORT_EXCLUDE_SEGMENTS).toContain("bin");
    expect(stateExport.STATE_EXPORT_EXCLUDE_SEGMENTS).toContain("sessions");
    expect(stateExport.STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS).toContain("*-wal");
    expect(stateExport.STATE_EXPORT_ARCHIVE_ROOT).toBe(".openclaw");
  });

  it("accepts every fixture path the export must contain", () => {
    for (const relativePath of EXPECTED_INCLUDED) {
      expect(stateExport.filterStateEntry(relativePath, fileDirent), relativePath).toBe(true);
    }
  });

  it("rejects every decoy, whether reached as a file or as its directory", () => {
    for (const relativePath of DECOYS) {
      expect(stateExport.filterStateEntry(relativePath, fileDirent), relativePath).toBe(false);
    }
    for (const directory of [
      "bin",
      "lib",
      "agents/main/sessions",
      "agents/main/agent/plugins",
      // Excluded basename patterns apply to directories too (AC-FN-001):
      "credentials/old.bak-1",
      "memory/x.migrated"
    ]) {
      expect(stateExport.filterStateEntry(directory, dirDirent), directory).toBe(false);
    }
  });

  it("rejects an excluded segment even when it sits under an include root", () => {
    expect(stateExport.filterStateEntry("memory/logs/today.log", fileDirent)).toBe(false);
    expect(stateExport.filterStateEntry("credentials/backups/old.json", fileDirent)).toBe(false);
    expect(stateExport.filterStateEntry("state/openclaw.sqlite-shm", fileDirent)).toBe(false);
    expect(stateExport.filterStateEntry("cron/jobs.json.migrated", fileDirent)).toBe(false);
  });

  it("rejects paths outside the include list by default", () => {
    expect(stateExport.filterStateEntry("random.txt", fileDirent)).toBe(false);
    expect(stateExport.filterStateEntry("agents/main/agent/notes.txt", fileDirent)).toBe(false);
    expect(stateExport.filterStateEntry("agents/main/agent/deeper/x.sqlite", fileDirent)).toBe(false);
    expect(stateExport.filterStateEntry("../escape.json", fileDirent)).toBe(false);
  });

  it("rejects symlinks and non-regular entries regardless of path", () => {
    expect(stateExport.filterStateEntry("openclaw.json", symlinkDirent)).toBe(false);
    expect(stateExport.filterStateEntry("credentials", symlinkDirent)).toBe(false);
    expect(stateExport.filterStateEntry("credentials/agent.sock", socketDirent)).toBe(false);
  });

  it("lets the walk descend through include-root directories and agents/<id>/agent only", () => {
    expect(stateExport.filterStateEntry("", dirDirent)).toBe(true);
    expect(stateExport.filterStateEntry("credentials", dirDirent)).toBe(true);
    expect(stateExport.filterStateEntry("agents", dirDirent)).toBe(true);
    expect(stateExport.filterStateEntry("agents/main", dirDirent)).toBe(true);
    expect(stateExport.filterStateEntry("agents/main/agent", dirDirent)).toBe(true);
    expect(stateExport.filterStateEntry("agents/main/agent/codex-home", dirDirent)).toBe(false);
    expect(stateExport.filterStateEntry("agents/main/workspace", dirDirent)).toBe(false);
  });
});

// Skipped (visibly) when import("node:sqlite") rejects: buildStateExportTree
// refuses to export any *.sqlite without it, so these tests cannot run.
describe.skipIf(!sqliteAvailable)("wrapper-state-export: buildStateExportTree on a real STATE_DIR fixture", () => {
  let fixture: StateDirFixture;
  let targetRoot: string;
  let produced: { files: string[]; bytes: number };

  beforeAll(async () => {
    fixture = buildStateDirFixture(sqliteModule);
    targetRoot = join(fixture.root, "export-target");
    produced = await stateExport.buildStateExportTree({ stateDir: fixture.stateDir, targetRoot });
  });

  afterAll(() => {
    destroyStateDirFixture(fixture);
  });

  it("keeps the WAL un-checkpointed in the source fixture (precondition for AC-TST-002)", () => {
    const walPath = join(fixture.stateDir, "state", "openclaw.sqlite-wal");
    expect(existsSync(walPath)).toBe(true);
    expect(lstatSync(walPath).size).toBeGreaterThan(0);
    expect(lstatSync(join(fixture.stateDir, ...fixture.symlinkRelativePath.split("/"))).isSymbolicLink()).toBe(true);
  });

  // AC-TST-001
  it("produces exactly the include set: every path accepted by filterStateEntry, none excluded, no symlink", () => {
    const onDisk = listTreeFiles(targetRoot);
    expect(new Set(onDisk)).toEqual(new Set(produced.files));

    const relativePaths = produced.files.map((archivePath) => {
      expect(archivePath.startsWith(`${stateExport.STATE_EXPORT_ARCHIVE_ROOT}/`)).toBe(true);
      return archivePath.slice(stateExport.STATE_EXPORT_ARCHIVE_ROOT.length + 1);
    });

    // Issue #79's zero-byte -wal/-shm placeholders are synthesized directly
    // next to each snapshot, not paths walked from (and filtered out of) the
    // source tree, so they are carved out before the filterStateEntry/exclude
    // invariants below -- which describe what the walk may copy FROM the
    // source, and correctly reject a -wal/-shm basename there (AC-TST-001's
    // decoys include exactly that: a live source-side `state/openclaw.sqlite-wal`).
    const sidecarPlaceholders = relativePaths.filter((p) => p.endsWith("-wal") || p.endsWith("-shm"));
    const sourcedPaths = relativePaths.filter((p) => !sidecarPlaceholders.includes(p));

    expect(new Set(sidecarPlaceholders)).toEqual(
      new Set(EXPECTED_INCLUDED.filter((p) => p.endsWith(".sqlite")).flatMap((p) => [`${p}-wal`, `${p}-shm`]))
    );
    expect(new Set(sourcedPaths)).toEqual(new Set(EXPECTED_INCLUDED));

    const excludeBasenames = stateExport.STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS.map(globToRegExp);
    for (const relativePath of sourcedPaths) {
      expect(stateExport.filterStateEntry(relativePath, fileDirent), relativePath).toBe(true);
      const segments = segmentsOf(relativePath);
      for (const segment of segments) {
        expect(stateExport.STATE_EXPORT_EXCLUDE_SEGMENTS, relativePath).not.toContain(segment);
      }
      const basename = segments[segments.length - 1] ?? "";
      expect(excludeBasenames.some((re) => re.test(basename)), relativePath).toBe(false);
    }
    for (const decoy of [...DECOYS, fixture.symlinkRelativePath]) {
      expect(sourcedPaths, decoy).not.toContain(decoy);
    }
    // The symlink target directory is a junction on win32; nothing under it may
    // have been walked through the link either.
    for (const relativePath of sourcedPaths) {
      expect(relativePath.startsWith(`${fixture.symlinkRelativePath}/`), relativePath).toBe(false);
    }
  });

  it("copies non-sqlite files byte-for-byte and reports the accounted total", () => {
    const source = readFileSync(join(fixture.stateDir, "credentials", "oauth.json"));
    const copied = readFileSync(join(targetRoot, ".openclaw", "credentials", "oauth.json"));
    expect(copied.equals(source)).toBe(true);
    const totalOnDisk = listTreeFiles(targetRoot).reduce(
      (sum, relative) => sum + lstatSync(join(targetRoot, ...relative.split("/"))).size,
      0
    );
    expect(produced.bytes).toBe(totalOnDisk);
  });

  // AC-TST-002
  it("snapshots the WAL-mode SQLite consistently: all rows present, integrity ok, only zero-byte placeholders beside it", () => {
    const sqlite = sqliteModule as SqliteModule;
    const snapshotPath = join(targetRoot, ".openclaw", "state", "openclaw.sqlite");
    expect(existsSync(snapshotPath)).toBe(true);
    // Issue #79: a zero-byte placeholder, not the absence of a sidecar --
    // see the dedicated placeholder test above for the full assertion.
    expect(existsSync(`${snapshotPath}-wal`)).toBe(true);
    expect(lstatSync(`${snapshotPath}-wal`).size).toBe(0);
    expect(existsSync(`${snapshotPath}-shm`)).toBe(true);
    expect(lstatSync(`${snapshotPath}-shm`).size).toBe(0);

    const snapshot = new sqlite.DatabaseSync(snapshotPath, { readOnly: true });
    try {
      const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
      expect(integrity.integrity_check).toBe("ok");
      const rows = snapshot.prepare("SELECT id, body FROM notes ORDER BY id").all() as Array<{
        id: number;
        body: string;
      }>;
      expect(rows).toEqual(SNAPSHOT_ROWS);
      // A snapshot is a standalone rollback-journal database, not a WAL one.
      const journalMode = snapshot.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journalMode.journal_mode).not.toBe("wal");
    } finally {
      snapshot.close();
    }
  });

  // Issue #79: the wrapper's /setup/import extracts without clearing
  // pre-existing -wal/-shm sidecars first, so a stale sidecar left over from
  // the target's own live WAL survives a restore beside a freshly-imported
  // main file. A zero-byte placeholder for each sqlite entry works around it
  // -- extracting a zero-byte file over the target's stale sidecar truncates
  // it, so SQLite finds an empty WAL (nothing to replay) on next open.
  it("writes a zero-byte -wal/-shm placeholder alongside every VACUUM INTO snapshot", () => {
    const sqliteEntries = produced.files.filter((archivePath) => archivePath.endsWith(".sqlite"));
    expect(sqliteEntries.length).toBeGreaterThan(0);
    for (const archivePath of sqliteEntries) {
      for (const suffix of ["-wal", "-shm"]) {
        const sidecarArchivePath = `${archivePath}${suffix}`;
        expect(produced.files, sidecarArchivePath).toContain(sidecarArchivePath);
        const onDiskPath = join(targetRoot, ...sidecarArchivePath.split("/"));
        expect(existsSync(onDiskPath), sidecarArchivePath).toBe(true);
        expect(lstatSync(onDiskPath).size, sidecarArchivePath).toBe(0);
      }
    }
  });

  // AC from issue #79: a target with a pre-existing non-empty -wal ends up
  // truncated after import. Exercised through the real `tar` package the
  // patched wrapper uses server-side (tar.c to build the export, tar.x to
  // extract it), not a hand-rolled simulation of extraction semantics.
  it("restoring the produced archive over a target with a live, non-empty -wal truncates it to zero bytes", async () => {
    const archiveDir = join(fixture.root, "archive-out");
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, "state.tar.gz");
    await tar.c({ gzip: true, portable: true, noMtime: true, cwd: targetRoot, file: archivePath }, [
      stateExport.STATE_EXPORT_ARCHIVE_ROOT
    ]);

    const restoreTarget = join(fixture.root, "restore-target");
    const staleWalPath = join(restoreTarget, stateExport.STATE_EXPORT_ARCHIVE_ROOT, "state", "openclaw.sqlite-wal");
    mkdirSync(dirname(staleWalPath), { recursive: true });
    writeFileSync(staleWalPath, Buffer.alloc(4096, 0xff)); // stands in for the target's own live, un-checkpointed WAL

    await tar.x({ cwd: restoreTarget, file: archivePath });

    expect(existsSync(staleWalPath)).toBe(true);
    expect(lstatSync(staleWalPath).size).toBe(0);
  });

  it("snapshotSqlite refuses to run on a missing source rather than producing an empty target", async () => {
    const missing = join(fixture.root, "does-not-exist.sqlite");
    const target = join(fixture.root, "snapshot-of-missing.sqlite");
    await expect(stateExport.snapshotSqlite(missing, target)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
  });

  // AC-TST-003
  it("rejects before completion when maxBytes is smaller than the fixture, leaving only the bare tree", async () => {
    const cappedTarget = join(fixture.root, "capped-target");
    const maxBytes = 16;
    await expect(
      stateExport.buildStateExportTree({ stateDir: fixture.stateDir, targetRoot: cappedTarget, maxBytes })
    ).rejects.toThrow(new RegExp(`${maxBytes}-byte cap \\(${stateExport.STATE_EXPORT_MAX_BYTES_ENV}\\)`));

    // Whatever landed before the throw is a strict subset of the include set
    // and lives only under the archive root; no archive or stray artifact.
    const entriesAtRoot = readdirSync(cappedTarget);
    expect(entriesAtRoot).toEqual([stateExport.STATE_EXPORT_ARCHIVE_ROOT]);
    const partial = listTreeFiles(cappedTarget);
    expect(partial.length).toBeLessThan(produced.files.length);
    for (const relative of partial) {
      expect(produced.files).toContain(relative);
    }
  });

  it("throws on a missing state directory instead of producing an empty export", async () => {
    await expect(
      stateExport.buildStateExportTree({
        stateDir: join(fixture.root, "no-such-state-dir"),
        targetRoot: join(fixture.root, "unused-target")
      })
    ).rejects.toThrow(/missing or not a directory/);
  });
});

describe("wrapper patch scripts on a synthetic server.js fixture", () => {
  let workDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "wrapper-patch-test-"));
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  function freshFixture(name: string): string {
    const target = join(workDir, `${name}.js`);
    writeFileSync(target, SYNTHETIC_SERVER_JS);
    return target;
  }

  it("fixture is valid ESM and carries all four sleep(750) sites and every anchor", () => {
    const fixturePath = freshFixture("baseline");
    expect(nodeCheck(fixturePath)).toBe(0);
    expect(countOccurrences(SYNTHETIC_SERVER_JS, SLEEP_750)).toBe(4);
    for (const anchor of [
      `import * as tar from "tar";`,
      EXPORT_HANDLER_OPENING_LINE,
      "function isUnderDir(p, root) {",
      "// Import a backup created by /setup/export.",
      `app.post("/setup/import", requireSetupAuth, async (req, res) => {`,
      "async function restartGateway() {"
    ]) {
      expect(countOccurrences(SYNTHETIC_SERVER_JS, anchor), anchor).toBe(1);
    }
  });

  // AC-TST-004 (restart-gateway half)
  it("patch-wrapper-restart-gateway applies once (exit 0, node --check ok) and refuses a second run", () => {
    const fixturePath = freshFixture("restart");

    const first = runPatchScript(restartGatewayPatchPath, fixturePath);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("stopGatewayAndWait()");
    expect(nodeCheck(fixturePath)).toBe(0);

    const patched = readFileSync(fixturePath, "utf8");
    expect(countOccurrences(patched, "async function stopGatewayAndWait() {")).toBe(1);
    expect(patched.indexOf("async function stopGatewayAndWait() {")).toBeLessThan(
      patched.indexOf("async function restartGateway() {")
    );

    const second = runPatchScript(restartGatewayPatchPath, fixturePath);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/found 1 occurrence\(s\)/);
    expect(second.stderr).toMatch(/refusing to apply the restart-gateway patch twice/);
    // A refused run must not touch the file.
    expect(readFileSync(fixturePath, "utf8")).toBe(patched);
  });

  // AC-TST-005
  it("replaces only the restartGateway and /setup/import sleep sites; the two unrelated sites survive verbatim", () => {
    const fixturePath = freshFixture("site-specific");
    expect(runPatchScript(restartGatewayPatchPath, fixturePath).status).toBe(0);
    const patched = readFileSync(fixturePath, "utf8");

    // 4 -> 2, matching the Dockerfile's `grep -cF 'await sleep(750);'` == 2 assertion.
    expect(countOccurrences(patched, SLEEP_750)).toBe(2);

    // Sites 2 and 3 (gateway.stop, POST /setup/api/reset) are byte-identical to the original.
    expect(countOccurrences(patched, GATEWAY_STOP_BLOCK_UNRELATED)).toBe(1);
    expect(countOccurrences(patched, RESET_STOP_BLOCK_UNRELATED)).toBe(1);

    // Sites 1 and 4 are gone and now delegate to the shared helper.
    expect(patched).not.toContain(RESTART_GATEWAY_ORIGINAL);
    expect(patched).not.toContain(IMPORT_STOP_BLOCK_ORIGINAL);
    expect(patched).toContain(`async function restartGateway() {
  if (gatewayProc) {
    await stopGatewayAndWait();
  }
  return ensureGatewayRunning();
}`);
    expect(patched).toContain(`    // Stop gateway before restore so we don't overwrite live files.
    if (gatewayProc) {
      await stopGatewayAndWait();
    }`);
    // Two call sites plus the definition's own name: exactly three mentions.
    expect(countOccurrences(patched, "stopGatewayAndWait")).toBe(3);

    // Nothing outside the two sites changed: strip the definition and the two
    // rewritten blocks from the patched text, strip the two original blocks
    // from the fixture, and the remainders must be identical.
    const definitionEnd = patched.indexOf("\n\nasync function restartGateway() {");
    const definition = patched.slice(patched.indexOf("async function stopGatewayAndWait() {"), definitionEnd + 2);
    const patchedRemainder = patched
      .replace(definition, "")
      .replace("    await stopGatewayAndWait();\n", "")
      .replace("      await stopGatewayAndWait();\n", "");
    const originalRemainder = SYNTHETIC_SERVER_JS.replace(
      `    try {
      gatewayProc.kill("SIGTERM");
    } catch {
      // ignore
    }
    // Give it a moment to exit and release the port.
    await sleep(750);
    gatewayProc = null;
`,
      ""
    ).replace(
      `      try { gatewayProc.kill("SIGTERM"); } catch {}
      await sleep(750);
      gatewayProc = null;
`,
      ""
    );
    expect(patchedRemainder).toBe(originalRemainder);
  });

  // AC-TST-004 (scoped-export half)
  it("patch-wrapper-scoped-export applies once (exit 0, node --check ok) and refuses a second run", () => {
    const fixturePath = freshFixture("scoped");

    const first = runPatchScript(scopedExportPatchPath, fixturePath);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("?scope=state");
    expect(nodeCheck(fixturePath)).toBe(0);

    const patched = readFileSync(fixturePath, "utf8");
    // Mirrors the Dockerfile's grep -qF assertions.
    expect(countOccurrences(patched, `import { buildStateExportTree } from "./wrapper-state-export.mjs";`)).toBe(1);
    expect(countOccurrences(patched, `if (scope === "state") {`)).toBe(1);
    // The delegate is a prefix: the original handler body follows it byte-identically (AC-FN-008).
    expect(countOccurrences(patched, EXPORT_HANDLER_BODY_ORIGINAL)).toBe(1);
    expect(patched.indexOf(`if (scope === "state") {`)).toBeLessThan(patched.indexOf(EXPORT_HANDLER_BODY_ORIGINAL));
    // No sleep site is touched by this script.
    expect(countOccurrences(patched, SLEEP_750)).toBe(4);

    const second = runPatchScript(scopedExportPatchPath, fixturePath);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toMatch(/found 1 occurrence\(s\)/);
    expect(second.stderr).toMatch(/refusing to apply the scoped-export patch twice/);
    expect(readFileSync(fixturePath, "utf8")).toBe(patched);
  });

  it("both scripts compose in the Dockerfile's order and the result still passes node --check", () => {
    const fixturePath = freshFixture("composed");
    expect(runPatchScript(restartGatewayPatchPath, fixturePath).status).toBe(0);
    expect(runPatchScript(scopedExportPatchPath, fixturePath).status).toBe(0);
    expect(nodeCheck(fixturePath)).toBe(0);
    const patched = readFileSync(fixturePath, "utf8");
    expect(countOccurrences(patched, SLEEP_750)).toBe(2);
    expect(countOccurrences(patched, "stopGatewayAndWait")).toBe(3);
    expect(countOccurrences(patched, `if (scope === "state") {`)).toBe(1);
  });

  it("exits non-zero with the occurrence count when an anchor is missing or duplicated", () => {
    const missingAnchor = join(workDir, "missing-anchor.js");
    writeFileSync(missingAnchor, SYNTHETIC_SERVER_JS.replace(IMPORT_STOP_BLOCK_ORIGINAL, "    // stop block removed\n"));
    const missing = runPatchScript(restartGatewayPatchPath, missingAnchor);
    expect(missing.status).not.toBe(0);
    expect(missing.stderr).toMatch(/expected exactly 1 occurrence of the \/setup\/import handler[^\n]*found 0/);

    const duplicatedAnchor = join(workDir, "duplicated-anchor.js");
    writeFileSync(duplicatedAnchor, `${SYNTHETIC_SERVER_JS}\n${EXPORT_HANDLER_OPENING_LINE}\n});\n`);
    const duplicated = runPatchScript(scopedExportPatchPath, duplicatedAnchor);
    expect(duplicated.status).not.toBe(0);
    expect(duplicated.stderr).toMatch(/expected exactly 1 occurrence of the \/setup\/export handler[^\n]*found 2/);
    // Guards run before any write: the input is untouched on refusal.
    expect(readFileSync(duplicatedAnchor, "utf8")).toBe(`${SYNTHETIC_SERVER_JS}\n${EXPORT_HANDLER_OPENING_LINE}\n});\n`);
  });

  it("without a target path both scripts print usage and exit non-zero", () => {
    for (const scriptPath of [restartGatewayPatchPath, scopedExportPatchPath]) {
      const result = spawnSync(process.execPath, [scriptPath], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/^usage: node patch-wrapper-/);
    }
  });
});
