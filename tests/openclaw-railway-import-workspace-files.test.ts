import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as tar from "tar";
import { describe, expect, it } from "vitest";

import {
  buildWorkspaceArchive,
  importWorkspaceFiles
} from "@openclaw-control-plane/openclaw-railway-installer/import-workspace-files";

const AUTH = { username: "openclaw-admin", password: "setup-secret" };
const BASE_URL = "https://example-openclaw.example.com";

async function extractArchive(archive: Buffer): Promise<string> {
  const scratchDir = await mkdtemp(join(tmpdir(), "openclaw-import-test-"));
  const tarPath = join(scratchDir, "archive.tar.gz");
  await writeFile(tarPath, archive);
  await tar.x({ file: tarPath, cwd: scratchDir, gzip: true });
  return scratchDir;
}

describe("buildWorkspaceArchive", () => {
  it("round-trips every input file byte-for-byte under workspace/, with no extra entries", async () => {
    const files = {
      "IDENTITY.md": "# Identity\n\nName: Aria\n",
      "USER.md": "- Prefer concise replies\n",
      "SOUL.md": "## Core Truths\n\nBe kind.\n"
    };

    const archive = await buildWorkspaceArchive(files);
    const scratchDir = await extractArchive(archive);
    try {
      const workspaceEntries = await readdir(join(scratchDir, "workspace"));
      expect(new Set(workspaceEntries)).toEqual(new Set(Object.keys(files)));

      for (const [name, content] of Object.entries(files)) {
        const extracted = await readFile(join(scratchDir, "workspace", name), "utf8");
        expect(extracted).toBe(content);
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("never injects BOOTSTRAP.md or any file the caller didn't provide", async () => {
    const archive = await buildWorkspaceArchive({ "IDENTITY.md": "# Identity\n" });
    const scratchDir = await extractArchive(archive);
    try {
      const workspaceEntries = await readdir(join(scratchDir, "workspace"));
      expect(workspaceEntries).toEqual(["IDENTITY.md"]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it.each(["../escape.md", "..\\escape.md", "/etc/passwd", "C:\\Windows\\win.ini", "..", "sub/dir.md"])(
    "rejects an unsafe filename (%s) before writing anything to disk",
    async (unsafeName) => {
      await expect(buildWorkspaceArchive({ [unsafeName]: "content" })).rejects.toThrow(/Unsafe workspace filename/);
    }
  );
});

describe("importWorkspaceFiles", () => {
  it("posts the same archive buildWorkspaceArchive would produce, with the caller's auth unmodified", async () => {
    const files = { "IDENTITY.md": "# Identity\n", "USER.md": "- Prefer concise replies\n" };
    let capturedAuth: typeof AUTH | undefined;
    let capturedArchive: Buffer | undefined;

    const result = await importWorkspaceFiles(BASE_URL, AUTH, files, {
      postImport: async (baseUrl, auth, archive) => {
        expect(baseUrl).toBe(BASE_URL);
        capturedAuth = auth;
        capturedArchive = archive;
        return { ok: true, status: 200, body: "OK - imported backup into /data and restarted gateway.\n" };
      }
    });

    expect(capturedAuth).toEqual(AUTH);
    expect(result).toEqual({ status: 200, body: "OK - imported backup into /data and restarted gateway.\n" });

    // The captured archive round-trips to the same file map the transport layer was given.
    const scratchDir = await extractArchive(capturedArchive as Buffer);
    try {
      const extracted = await readFile(join(scratchDir, "workspace", "IDENTITY.md"), "utf8");
      expect(extracted).toBe(files["IDENTITY.md"]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  it("throws with the HTTP status and response body when postImport reports ok:false, and does not retry", async () => {
    let callCount = 0;

    await expect(
      importWorkspaceFiles(BASE_URL, AUTH, { "IDENTITY.md": "# Identity\n" }, {
        postImport: async () => {
          callCount += 1;
          return {
            ok: false,
            status: 400,
            body: "Import is only supported when OPENCLAW_STATE_DIR and OPENCLAW_WORKSPACE_DIR are under /data (Railway volume).\n"
          };
        }
      })
    ).rejects.toThrow(/400.*OPENCLAW_STATE_DIR/s);

    expect(callCount).toBe(1);
  });
});

describe("importWorkspaceFiles has no production callers", () => {
  // Gap G3 (docs/live-instance-operations.md §7): this module POSTs
  // unconditionally with no pre-read comparison, deferred as low-urgency
  // *because* it is currently unwired from both provisioning paths. That
  // deferral only holds while the premise does -- "fix it when it gains a
  // caller" otherwise depends on whoever wires it up having read the
  // register first. This makes the premise a tripwire: the day a
  // production module imports this one, this test fails and points here
  // instead of the caller finding out from an incident.
  //
  // Source-text scan across every production src tree (apps/*/src,
  // packages/*/src, workers/*/src), not an import-graph walk -- same
  // known limitation as the G4 closure's equivalent check: it cannot
  // catch a future re-export of this module under an unrelated name.
  const forbiddenImportPattern = /(?:from\s+|import\s*\(\s*|import\s+)["'`][^"'`]*import-workspace-files[^"'`]*["'`]/;
  const productionSourceRoots = ["apps", "packages", "workers"];
  // Excluded by its exact path, not by bare filename -- a filename-only
  // exclusion would silently skip any *future* file elsewhere in the tree
  // that happened to share this name, defeating the tripwire for exactly
  // the case it exists to catch.
  const moduleUnderTestPath = join("packages", "openclaw-railway-installer", "src", "import-workspace-files.ts");

  async function listProductionTsFiles(root: string): Promise<string[]> {
    // `apps/` no longer exists in this repo (the Decision Runtime that lived
    // there moved to its own repository) -- a workspace root with nothing
    // left under it is "no files to scan", not a failure, so an absent
    // directory is treated the same as an empty one rather than throwing.
    try {
      const entries = await readdir(root, { withFileTypes: true, recursive: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => join(entry.parentPath ?? entry.path, entry.name))
        .filter((path) => path.split(/[\\/]/).includes("src"))
        .filter((path) => !path.endsWith(moduleUnderTestPath));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
  }

  it("no file under apps/*/src, packages/*/src, or workers/*/src imports import-workspace-files.js", async () => {
    const files = (
      await Promise.all(productionSourceRoots.map((root) => listProductionTsFiles(root)))
    ).flat();
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (forbiddenImportPattern.test(source)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});
