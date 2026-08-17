import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";

import { basicAuthHeader, type SetupAuth } from "./setup-auth.js";

// Issue #20 (transport half only -- content ownership lives in the private
// [private-repo] repo). Confirmed live against
// vignesh07/clawdbot-railway-template@main's src/server.js: POST
// /setup/import extracts a gzip'd tar into /data (cwd), does not delete
// existing files first, and returns plain text -- not the {ok: boolean}
// JSON shape the wrapper's other /setup/api/* endpoints use -- so success
// here is HTTP status only, not a JSON ok-flag check.

export interface ImportWorkspaceFilesDependencies {
  postImport?:
    | ((baseUrl: string, auth: SetupAuth, archive: Buffer) => Promise<{ ok: boolean; status: number; body: string }>)
    | undefined;
}

export interface ImportWorkspaceFilesResult {
  status: number;
  body: string;
}

/**
 * Packs `files` (workspace-relative filename -> content) into a `workspace/`
 * tar.gz and POSTs it to the wrapper's `/setup/import`. Generic transport --
 * callers decide which files to send (e.g. IDENTITY.md/USER.md/SOUL.md,
 * deliberately omitting BOOTSTRAP.md to skip the first-run Q&A ritual).
 */
export async function importWorkspaceFiles(
  baseUrl: string,
  auth: SetupAuth,
  files: Record<string, string>,
  dependencies: ImportWorkspaceFilesDependencies = {}
): Promise<ImportWorkspaceFilesResult> {
  const postImport = dependencies.postImport ?? defaultPostImport;

  const archive = await buildWorkspaceArchive(files);
  const result = await postImport(baseUrl, auth, archive);
  if (!result.ok) {
    throw new Error(`POST /setup/import returned ${result.status}: ${result.body}`);
  }
  return { status: result.status, body: result.body };
}

/**
 * Builds a gzip'd tar with each entry of `files` written under `workspace/`,
 * using the same `tar` library the wrapper itself uses server-side to
 * extract, for format compatibility.
 */
export async function buildWorkspaceArchive(files: Record<string, string>): Promise<Buffer> {
  for (const name of Object.keys(files)) {
    assertSafeWorkspaceFilename(name);
  }

  const stagingDir = await mkdtemp(join(tmpdir(), "openclaw-workspace-import-"));
  try {
    const workspaceDir = join(stagingDir, "workspace");
    await mkdir(workspaceDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(workspaceDir, name), content, "utf8");
    }

    const chunks: Buffer[] = [];
    const packStream = tar.create({ gzip: true, cwd: stagingDir }, ["workspace"]);
    for await (const chunk of packStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } finally {
    await rm(stagingDir, { recursive: true, force: true });
  }
}

// Validated locally, before any write: `buildWorkspaceArchive` stages files
// on this machine's real filesystem ahead of tarring them (`writeFile(join(
// workspaceDir, name), ...)`), so a traversal/absolute `name` could write
// outside the staging dir here -- a distinct risk from the wrapper's own
// server-side `looksSafeTarPath`, which only guards its `/data` extraction,
// not this local staging step. This module has only flat-filename callers
// today (IDENTITY.md/USER.md/SOUL.md); subdirectories aren't supported.
function assertSafeWorkspaceFilename(name: string): void {
  if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Unsafe workspace filename: ${JSON.stringify(name)}`);
  }
}

async function defaultPostImport(
  baseUrl: string,
  auth: SetupAuth,
  archive: Buffer
): Promise<{ ok: boolean; status: number; body: string }> {
  const response = await fetch(`${baseUrl}/setup/import`, {
    method: "POST",
    headers: { "content-type": "application/gzip", authorization: basicAuthHeader(auth) },
    body: archive
  });
  const body = await response.text();
  return { ok: response.ok, status: response.status, body };
}
