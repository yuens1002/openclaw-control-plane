// Patches the pinned Railway wrapper's GET /setup/export handler with a
// `?scope=state` delegate that archives only the instance's state subset
// (config, credentials, devices, cron, identity, memory, exec approvals, and
// VACUUM INTO snapshots of every SQLite store) instead of the whole
// STATE_DIR + WORKSPACE_DIR tree. The logic lives in
// scripts/wrapper-state-export.mjs (copied into the image as
// src/wrapper-state-export.mjs); this script only injects the import line and
// the delegate. See the Dockerfile comment above the RUN step that invokes
// this script for the rationale, measured sizes, and issue links.
//
// Same shape as patch-wrapper-restart-gateway.mjs: exact literal block
// matches via String.prototype.replace, each guarded to exactly one
// occurrence, all guards evaluated before anything is written. A template
// bump that moves either anchor fails the image build instead of silently
// shipping an unpatched wrapper.

import fs from "node:fs";

const targetPath = process.argv[2];
if (!targetPath) {
  console.error("usage: node patch-wrapper-scoped-export.mjs <path-to-server.js>");
  process.exit(1);
}

const replacements = [
  {
    label: "tar import line (anchor for the wrapper-state-export import)",
    oldBlock: `import * as tar from "tar";`,
    newBlock: `import * as tar from "tar";
import { buildStateExportTree } from "./wrapper-state-export.mjs";`,
  },
  {
    label: "/setup/export handler opening line (anchor for the ?scope=state delegate)",
    oldBlock: `app.get("/setup/export", requireSetupAuth, async (_req, res) => {`,
    newBlock: `app.get("/setup/export", requireSetupAuth, async (_req, res) => {
  // Control-plane patch (scripts/patch-wrapper-scoped-export.mjs): scoped
  // export. \`?scope=state\` archives only the state subset via
  // wrapper-state-export.mjs; any other non-empty scope is a 400; no scope
  // falls through to the unmodified full export below.
  {
    const scope = _req.query.scope;
    if (scope === "state") {
      const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-state-export-"));
      const removeTargetRoot = () => {
        try {
          fs.rmSync(targetRoot, { recursive: true, force: true });
        } catch {
          // best effort: the directory is under os.tmpdir()
        }
      };
      try {
        // maxBytes: wrapper-state-export.mjs resolves OPENCLAW_STATE_EXPORT_MAX_BYTES (default 200 MiB).
        await buildStateExportTree({ stateDir: STATE_DIR, targetRoot });
      } catch (err) {
        removeTargetRoot();
        console.error("[export] scope=state failed:", err);
        return res
          .status(500)
          .type("text/plain")
          .send(\`state export failed: \${err?.message ?? String(err)}\\n\`);
      }
      res.setHeader("content-type", "application/gzip");
      res.setHeader(
        "content-disposition",
        \`attachment; filename="openclaw-backup-state-\${new Date().toISOString().replace(/[:.]/g, "-")}.tar.gz"\`,
      );
      const stateStream = tar.c(
        {
          gzip: true,
          portable: true,
          noMtime: true,
          cwd: targetRoot,
          onwarn: () => {},
        },
        [".openclaw"],
      );
      stateStream.on("error", (err) => {
        console.error("[export] scope=state stream error:", err);
        if (!res.headersSent) res.status(500);
        res.end(String(err));
      });
      // finally-equivalent for a streamed response: the temp tree is removed
      // once the response closes, whether it completed, errored, or aborted.
      res.once("close", removeTargetRoot);
      stateStream.pipe(res);
      return;
    }
    if (scope !== undefined && scope !== "") {
      return res
        .status(400)
        .type("text/plain")
        .send(\`unknown export scope \${JSON.stringify(String(scope))}; supported: state\\n\`);
    }
  }`,
  },
];

const content = fs.readFileSync(targetPath, "utf8");

let failed = false;
for (const { label, oldBlock, newBlock } of replacements) {
  // Both anchors survive as a prefix of their own replacement, so an anchor
  // count alone cannot detect a second application: also require the
  // injected block to be absent.
  const alreadyApplied = content.split(newBlock).length - 1;
  if (alreadyApplied !== 0) {
    failed = true;
    console.error(
      `the ${label} replacement is already present in ${targetPath} (found ${alreadyApplied} occurrence(s) of the injected block); ` +
        "refusing to apply the scoped-export patch twice.",
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
console.log(`patched /setup/export with the ?scope=state delegate in ${targetPath}`);
