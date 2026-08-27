// Scoped state export for the pinned Railway wrapper (`GET /setup/export?scope=state`).
//
// This module is copied verbatim into the wrapper image next to src/server.js
// (Dockerfile `template-source` stage, `COPY scripts/wrapper-state-export.mjs
// src/wrapper-state-export.mjs`) and imported by the delegate that
// scripts/patch-wrapper-scoped-export.mjs injects at the top of the wrapper's
// existing /setup/export handler. It is also imported directly by this repo's
// vitest suite, so it must stay dependency-free: only `node:*` built-ins, and
// `node:sqlite` is loaded lazily via dynamic import so a runtime without it
// fails loudly at call time (a thrown error the handler turns into a 500)
// rather than at module load (which would take the whole wrapper down).
//
// Why a state *subset*: the wrapper's unscoped export tars all of STATE_DIR
// (measured 541 MB on a live instance; bin/ 415 MB, agents/main/sessions/
// 64 MB, lib/ 32 MB) while the state that actually needs backing up is
// about 7 MB. Why a snapshot: state/openclaw.sqlite runs in WAL mode, so a
// plain file copy of the main file without its -wal sibling is not a
// consistent database. `VACUUM INTO` on a read-only connection produces a
// single-file consistent copy. See
// https://github.com/yuens1002/openclaw-control-plane/issues/73.

import fs from "node:fs";
import path from "node:path";

// Roots relative to STATE_DIR. Files or directories; anything not under one
// of these is excluded by default (closed include list).
export const STATE_EXPORT_INCLUDE = Object.freeze([
  "openclaw.json",
  "exec-approvals.json",
  "credentials",
  "devices",
  "cron",
  "identity",
  "memory",
  "state",
  "agents",
]);

// Under `agents/<id>/agent/` only these direct children are included; the
// rest of an agent directory (sessions/, plugins/, codex-home/, ...) is bulk.
export const STATE_EXPORT_AGENT_ALLOWED = Object.freeze([
  "*.sqlite",
  "models.json",
  "auth-profiles*",
]);

// Path segments that are never exported, regardless of the include list.
// The include list is the primary gate; this list exists so the known bulk
// can be asserted absent even if an include root ever grows one of these.
export const STATE_EXPORT_EXCLUDE_SEGMENTS = Object.freeze([
  "bin",
  "lib",
  "media",
  "completions",
  "logs",
  "backups",
  "sessions",
  "plugins",
  "codex-home",
  "workspace",
  "nodes",
  "canvas",
  "skill-workshop",
  "plugin-skills",
  "workspace-attestations",
]);

// Basenames that are never exported. `-wal`/`-shm` are replaced by the
// VACUUM INTO snapshot of their main file; `*.bak*`/`*.migrated` are the
// wrapper's own leftovers from config migrations.
export const STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS = Object.freeze([
  "*.bak*",
  "*-wal",
  "*-shm",
  "*.migrated",
]);

export const STATE_EXPORT_DEFAULT_MAX_BYTES = 200 * 1024 * 1024;
export const STATE_EXPORT_MAX_BYTES_ENV = "OPENCLAW_STATE_EXPORT_MAX_BYTES";

// Archive root inside targetRoot. Matches what the wrapper's unscoped export
// produces for STATE_DIR=/data/.openclaw, so the archive is a valid input for
// the wrapper's own /setup/import (which extracts relative to /data).
export const STATE_EXPORT_ARCHIVE_ROOT = ".openclaw";

const AGENTS_ROOT = "agents";
const AGENT_SUBDIR = "agent";
const SQLITE_SUFFIX = ".sqlite";

// Written as zero-byte placeholders alongside every VACUUM INTO snapshot so
// the wrapper's own /setup/import (which extracts without clearing
// pre-existing sidecars first) truncates a target's stale -wal/-shm rather
// than leaving it stale beside a freshly-restored main file. See
// https://github.com/yuens1002/openclaw-control-plane/issues/79 and the
// upstream defect it works around,
// https://github.com/vignesh07/clawdbot-railway-template/issues/236.
const SQLITE_SIDECAR_SUFFIXES = Object.freeze(["-wal", "-shm"]);

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

const AGENT_ALLOWED_REGEXPS = STATE_EXPORT_AGENT_ALLOWED.map(globToRegExp);
const EXCLUDE_BASENAME_REGEXPS = STATE_EXPORT_EXCLUDE_BASENAME_PATTERNS.map(globToRegExp);
const EXCLUDE_SEGMENT_SET = new Set(STATE_EXPORT_EXCLUDE_SEGMENTS);
const INCLUDE_ROOT_SET = new Set(STATE_EXPORT_INCLUDE);

function toPosixSegments(relativePath) {
  return relativePath.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
}

function matchesAny(regexps, value) {
  return regexps.some((re) => re.test(value));
}

/**
 * Resolve the byte cap: the env override when set to a positive integer,
 * otherwise the 200 MiB default. A malformed override throws rather than
 * silently falling back, so a typo cannot quietly lift the cap.
 */
export function resolveStateExportMaxBytes(env = process.env) {
  const raw = env[STATE_EXPORT_MAX_BYTES_ENV];
  if (raw === undefined || raw.trim() === "") return STATE_EXPORT_DEFAULT_MAX_BYTES;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${STATE_EXPORT_MAX_BYTES_ENV} must be a positive integer number of bytes, got ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Decide whether a STATE_DIR entry belongs in the state export.
 *
 * @param {string} relativePath path relative to STATE_DIR (either separator)
 * @param {{ isFile(): boolean, isDirectory(): boolean, isSymbolicLink(): boolean }} dirent
 *   an fs.Dirent or fs.Stats-like object obtained WITHOUT following symlinks
 * @returns {boolean} true to descend into (directory) or copy (file)
 *
 * Only regular files and directories can pass; symlinks, sockets, devices and
 * FIFOs always fail. Directories pass when they are an include root, are under
 * one, or are an ancestor of one (so the walk can reach it). Files pass only
 * under an include root, and under `agents/<id>/agent/` only when their
 * basename matches STATE_EXPORT_AGENT_ALLOWED. Excluded segments and basename
 * patterns win over everything.
 */
export function filterStateEntry(relativePath, dirent) {
  if (!dirent || typeof dirent.isSymbolicLink !== "function") return false;
  if (dirent.isSymbolicLink()) return false;
  const isDirectory = dirent.isDirectory();
  const isFile = dirent.isFile();
  if (!isDirectory && !isFile) return false;

  const segments = toPosixSegments(relativePath);
  if (segments.length === 0) return isDirectory; // STATE_DIR itself
  if (segments.some((segment) => segment === ".." || EXCLUDE_SEGMENT_SET.has(segment))) return false;

  // Basename patterns apply to EVERY segment, not just the leaf, and to
  // directories as well as files: a directory named `old.bak-1` (or anything
  // beneath it) must never be exported, whether the walk asks about the
  // directory itself or a file inside it.
  if (segments.some((segment) => matchesAny(EXCLUDE_BASENAME_REGEXPS, segment))) return false;

  const basename = segments[segments.length - 1];

  const [root] = segments;
  if (!INCLUDE_ROOT_SET.has(root)) return false;

  if (root === AGENTS_ROOT) {
    // agents/<id>/agent/<allowed basename>; directories only down to agents/<id>/agent.
    if (isDirectory) {
      return segments.length <= 3 && (segments.length < 3 || segments[2] === AGENT_SUBDIR);
    }
    return segments.length === 4 && segments[2] === AGENT_SUBDIR && matchesAny(AGENT_ALLOWED_REGEXPS, basename);
  }

  return true;
}

/**
 * Write a consistent single-file copy of a SQLite database using
 * `VACUUM INTO` over a read-only `node:sqlite` connection. Never falls back to
 * a file copy: if `node:sqlite` is unavailable the returned promise rejects
 * with an error naming it, and the caller must fail the whole export.
 */
export async function snapshotSqlite(sourcePath, targetPath) {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (err) {
    throw new Error(
      `node:sqlite is unavailable in this runtime (${err?.message ?? String(err)}); ` +
        "refusing to hot-copy a WAL-mode database. A consistent SQLite snapshot requires Node >= 22.13.",
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // VACUUM INTO refuses to overwrite a non-empty file; a stale target from a
  // previous attempt would otherwise surface as an opaque SQLite error.
  fs.rmSync(targetPath, { force: true });
  const db = new sqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    const escapedTarget = targetPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escapedTarget}'`);
  } finally {
    db.close();
  }
}

/**
 * Build the export tree under `targetRoot/.openclaw/...` from `stateDir`.
 *
 * - Walks without following symlinks (readdir dirents + lstat only).
 * - Copies every regular file accepted by filterStateEntry.
 * - Snapshots every `*.sqlite` via snapshotSqlite instead of copying it.
 * - Accumulates bytes and throws (naming the cap) as soon as the running
 *   total exceeds `maxBytes`, so an oversized state is rejected before any
 *   archive bytes are streamed to a client.
 *
 * @returns {Promise<{ files: string[], bytes: number }>} archive-relative paths
 *   (`.openclaw/...`, POSIX separators) and the total bytes written.
 */
export async function buildStateExportTree({ stateDir, targetRoot, maxBytes } = {}) {
  if (!stateDir || !targetRoot) throw new Error("buildStateExportTree requires { stateDir, targetRoot }");
  const cap = maxBytes ?? resolveStateExportMaxBytes();
  const stateAbs = path.resolve(stateDir);
  const stateStat = fs.lstatSync(stateAbs, { throwIfNoEntry: false });
  if (!stateStat || !stateStat.isDirectory()) {
    throw new Error(`state directory ${stateAbs} is missing or not a directory`);
  }
  const archiveRoot = path.join(path.resolve(targetRoot), STATE_EXPORT_ARCHIVE_ROOT);
  fs.mkdirSync(archiveRoot, { recursive: true });

  const files = [];
  let bytes = 0;
  const account = (size, archivePath) => {
    bytes += size;
    if (bytes > cap) {
      throw new Error(
        `state export exceeds the ${cap}-byte cap (${STATE_EXPORT_MAX_BYTES_ENV}) at ${archivePath}; ` +
          `${files.length} files / ${bytes} bytes so far`,
      );
    }
  };

  const walk = async (relativeSegments) => {
    const sourceDir = path.join(stateAbs, ...relativeSegments);
    const dirents = fs.readdirSync(sourceDir, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const dirent of dirents) {
      const entrySegments = [...relativeSegments, dirent.name];
      const relativePath = entrySegments.join("/");
      if (!filterStateEntry(relativePath, dirent)) continue;
      if (dirent.isDirectory()) {
        await walk(entrySegments);
        continue;
      }
      const sourcePath = path.join(sourceDir, dirent.name);
      const targetPath = path.join(archiveRoot, ...entrySegments);
      const archivePath = `${STATE_EXPORT_ARCHIVE_ROOT}/${relativePath}`;
      const sourceSize = fs.lstatSync(sourcePath).size;
      if (dirent.name.endsWith(SQLITE_SUFFIX)) {
        // The snapshot is usually no larger than the source (VACUUM compacts),
        // so pre-account the source size to fail before doing the work, then
        // correct to the real size afterwards.
        account(sourceSize, archivePath);
        await snapshotSqlite(sourcePath, targetPath);
        const snapshotSize = fs.lstatSync(targetPath).size;
        bytes -= sourceSize;
        account(snapshotSize, archivePath);
        files.push(archivePath);
        // Zero-byte -wal/-shm placeholders: cost nothing real, but are still
        // accounted so every archive entry passes through the same cap check.
        for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
          const sidecarArchivePath = `${archivePath}${suffix}`;
          account(0, sidecarArchivePath);
          fs.writeFileSync(`${targetPath}${suffix}`, Buffer.alloc(0));
          files.push(sidecarArchivePath);
        }
        continue;
      }
      account(sourceSize, archivePath);
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      files.push(archivePath);
    }
  };

  await walk([]);
  return { files, bytes };
}
