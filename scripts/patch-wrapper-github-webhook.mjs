// Patches the pinned Railway wrapper with a new, wrapper-owned
// `POST /hooks/github-webhook-verify` route that verifies a GitHub App
// webhook delivery's `X-Hub-Signature-256` signature and responds 200/401
// accordingly -- registered before the catch-all
// `app.use(requireDashboardAuth, ...)` proxy to the OpenClaw gateway, so a
// request to it never reaches the gateway at all. The verification logic
// lives in scripts/wrapper-github-webhook-verify.mjs (copied into the image
// as src/wrapper-github-webhook-verify.mjs); this script only injects the
// import line and the route registration. See the Dockerfile comment above
// the RUN step that invokes this script for the rationale.
//
// Same shape as patch-wrapper-scoped-export.mjs: exact literal block matches
// via String.prototype.replace, each guarded to exactly one occurrence, all
// guards evaluated before anything is written. A template bump that moves
// either anchor fails the image build instead of silently shipping an
// unpatched wrapper.

import fs from "node:fs";

const targetPath = process.argv[2];
if (!targetPath) {
  console.error("usage: node patch-wrapper-github-webhook.mjs <path-to-server.js>");
  process.exit(1);
}

const replacements = [
  {
    label: "tar import line (anchor for the wrapper-github-webhook-verify import)",
    oldBlock: `import * as tar from "tar";`,
    newBlock: `import * as tar from "tar";
import { handleGithubWebhookVerify } from "./wrapper-github-webhook-verify.mjs";`,
  },
  {
    // Anchored on the global body-parser registration, NOT on the
    // requireDashboardAuth catch-all: registering the route right before the
    // catch-all still puts it earlier than the proxy in Express's
    // registration-order dispatch, but express.json() is registered earlier
    // still and unconditionally drains the request stream via its own
    // 'data'/'end' listeners before this route's handler ever runs --
    // readRawBody's own listeners then attach to an already-ended stream and
    // never fire, so every real request hung until its timeout and 400'd.
    // Confirmed against the real pinned wrapper: with the route anchored
    // here (before express.json), a signed POST returns 200 and an invalid
    // one 401, both immediately; anchored after express.json, both time out.
    label: "global JSON body-parser registration (anchor for the github-webhook route registration)",
    oldBlock: `app.use(express.json({ limit: "1mb" }));`,
    newBlock: `// Control-plane patch (scripts/patch-wrapper-github-webhook.mjs): registers
// POST /hooks/github-webhook-verify ahead of both the global express.json()
// body-parser below and the requireDashboardAuth catch-all further down, so
// a request to it is handled here -- with its own raw-body read, before
// anything else can consume the request stream -- and never reaches the
// OpenClaw gateway. Verification logic: ./wrapper-github-webhook-verify.mjs.
app.post("/hooks/github-webhook-verify", (req, res) => {
  handleGithubWebhookVerify(req, res).catch((err) => {
    console.error("[github-webhook-verify] handler error:", err);
    if (!res.headersSent) res.status(500).end();
  });
});

app.use(express.json({ limit: "1mb" }));`,
  },
];

const content = fs.readFileSync(targetPath, "utf8");

let failed = false;
for (const { label, oldBlock, newBlock } of replacements) {
  // Each anchor survives inside its own replacement (a prefix for the tar
  // import, a suffix for the route registration), so an anchor count alone
  // cannot detect a second application: also require the injected block to
  // be absent.
  const alreadyApplied = content.split(newBlock).length - 1;
  if (alreadyApplied !== 0) {
    failed = true;
    console.error(
      `the ${label} replacement is already present in ${targetPath} (found ${alreadyApplied} occurrence(s) of the injected block); ` +
        "refusing to apply the github-webhook patch twice.",
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
console.log(`patched ${targetPath} with the POST /hooks/github-webhook-verify route`);
