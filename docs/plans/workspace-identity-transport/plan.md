# Workspace Identity Transport Plan

## Cadence

Full cadence (docs convention only — this repo has not opted into the
hook-enforced `verification-status.json` state machine, so gates below are
run and recorded manually rather than blocked mechanically). Follows
`docs/plans/post-deploy-readiness/` as the structural precedent.

## Goal

Deliver the **transport primitive** for issue #20 ("Seed agent
identity/soul from client profile at apply time"): a function that packs
workspace-relative markdown files into a `tar.gz` and `POST`s it to the
wrapper's `/setup/import` endpoint, following the same
fetch-with-injectable-dependency pattern already used by
`patch-allowed-origins.ts` and `approve-own-device.ts`.

## Scope note — what this plan does NOT cover

Issue #20 splits ownership explicitly: **a private client-profile repo**
owns the *content* — intake fields, and templating the actual
`IDENTITY.md`/`USER.md`/`SOUL.md` markdown from those fields (tracked in
that repo's own #3, not yet done).
**control-plane** owns the *transport* — building the archive and calling
`/setup/import`. This plan is scoped to transport only:

- No content generation, no intake-schema changes, no markdown templating.
- No wiring into `installOpenClawOnRailway` (`index.ts`) or
  `provisionClientInstance` (`provision-client.ts`) — there is no real
  content to pass yet, and forcing a caller into either flow now would
  mean threading placeholder content through production code paths for no
  functional benefit. The function ships as a standalone, tested,
  unwired module — the next iteration wires it in once profile-repo #3
  lands.
- No resolution of issue #20's open second question (whether pre-seeding
  `IDENTITY.md` alone actually syncs into the UI's
  `agents.entries.*.identity` config, given `agents.*` commands aren't in
  the wrapper's `ALLOWED_CONSOLE_COMMANDS` allowlist) — that needs a live
  test against a real instance with real content, neither of which exist
  yet.

## Background (confirmed against wrapper source, not the issue's prior guess)

Read `vignesh07/clawdbot-railway-template@main`'s `src/server.js` directly
(the file this repo's own `Dockerfile` pulls in via
`ARG OPENCLAW_TEMPLATE_REF`) rather than trusting #18/#20's earlier,
explicitly-flagged-as-unverified description:

- **Auth**: `POST /setup/import` is gated by the same `requireSetupAuth`
  middleware as every other `/setup/*` route — Basic Auth, password only
  checked (username is ignored). Reuses `basicAuthHeader`/`SetupAuth` from
  `setup-auth.ts` unchanged.
- **Body**: raw gzip'd tar bytes read via a hand-rolled
  `readBodyBuffer(req, 250MB)` — not `multipart/form-data`. The wrapper's
  own browser uploader (`setup-app.js`) sends `content-type:
  application/gzip`; the server itself doesn't branch on content-type (it
  reads the raw stream directly, ahead of any `express.json()` body
  parser), but this plan matches the wrapper's own client for correctness
  and to avoid any future body-parsing middleware silently consuming the
  stream.
- **Extraction target**: `cwd: "/data"` (`dataRoot`), so tar entries must
  be relative paths under `/data` — `workspace/<file>` for our purposes,
  matching this repo's own `OPENCLAW_WORKSPACE_DIR=/data/workspace`
  provisioning variable. Entries are filtered through `looksSafeTarPath`
  (rejects leading `/`, `..` segments, and Windows drive letters)
  server-side. It does **not** delete existing files first — this is an
  overlay onto `/data`, not a wipe+restore.
- **Response shape is plain text, not JSON** — this is the one place this
  plan's design diverges from `patch-allowed-origins.ts`/
  `approve-own-device.ts`. Those two endpoints return `{ok: boolean, ...}`
  JSON, and a Copilot review on #22 correctly flagged that checking only
  the HTTP status wasn't enough defense-in-depth for them. `/setup/import`
  has no JSON `ok` field at all — success is `200` with body text starting
  `"OK - imported..."`, failure is `400`/`500` with an arbitrary plain-text
  message. HTTP status is the *only* signal available here; this plan's
  success check is `response.ok` (HTTP status) with no JSON parsing, and
  that is the correct, complete check for this endpoint specifically — not
  a repeat of the gap #22's review caught. Documented here so a future
  reviewer doesn't flag this as the same miss by pattern-matching without
  re-checking the actual response contract.
- **Size**: 250MB cap. Three short markdown files are trivially under
  this; no chunking/streaming concern.

## Design

New module `packages/openclaw-railway-installer/src/import-workspace-files.ts`:

```ts
export async function buildWorkspaceArchive(files: Record<string, string>): Promise<Buffer>
export async function importWorkspaceFiles(
  baseUrl: string,
  auth: SetupAuth,
  files: Record<string, string>,
  dependencies: ImportWorkspaceFilesDependencies = {}
): Promise<ImportWorkspaceFilesResult>
```

- `files` is a generic map of workspace-relative filename → content (e.g.
  `{ "IDENTITY.md": "...", "USER.md": "...", "SOUL.md": "..." }`) — not
  hardcoded to identity filenames, since this module's job is transport,
  not identity-specific logic. The expected first caller (once
  profile-repo #3 lands) will pass exactly those three keys and
  deliberately omit `BOOTSTRAP.md`, so the wrapper's first-run Q&A ritual
  is skipped — but that's the caller's decision, not this module's.
- `buildWorkspaceArchive` writes each entry to
  `<tmpdir>/workspace/<name>` under a fresh `fs.mkdtemp` staging directory,
  packs it with the real `tar` npm package (`tar.create({gzip: true, cwd:
  stagingDir}, ["workspace"])`, collected into a `Buffer`), then removes
  the staging directory in a `finally`. Using the real `tar` library
  (rather than a hand-rolled archive writer) is deliberate: it's the same
  library the wrapper itself uses server-side to extract
  (`import * as tar from "tar"` in `server.js`), which is the lowest-risk
  way to guarantee format compatibility.
- `importWorkspaceFiles` calls `buildWorkspaceArchive`, then an injectable
  `dependencies.postImport?` (mirroring `patchAllowedOrigins`'s
  `getConfigRaw?`/`postConfigRaw?` pattern) defaulting to a `fetch` POST
  with `content-type: application/gzip` and
  `authorization: basicAuthHeader(auth)`. Throws if `!result.ok`, message
  includes the HTTP status and response body text (there's no `requestId`
  or similar structured field to include, since the response is plain
  text).
- New dependency: `tar` (npm) added to
  `packages/openclaw-railway-installer/package.json`. Add `@types/tar`
  alongside it only if `tar` doesn't ship its own type declarations —
  confirm during implementation; `AC-REG-2` (typecheck) is the backstop
  either way.
- New `package.json` `exports` entry:
  `"./import-workspace-files": "./src/import-workspace-files.ts"`,
  matching every other module's export-per-file convention in this
  package.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role |
| --- | --- | --- | --- |
| D1 | Plan and ACs docs | docs | `/project-manager` |
| D2 | `import-workspace-files.ts` — `buildWorkspaceArchive` + `importWorkspaceFiles`, `tar` dependency, `package.json` `exports` entry | script | `/devops` |
| D3 | Mocked + round-trip tests | test | `/test-engineer` |
| D4 | Docs update | docs | `/project-manager` |

## Commit Schedule

1. `docs: add plan and ACs for workspace-identity-transport`
2. `feat(railway-installer): add importWorkspaceFiles transport for /setup/import`
3. `test(railway-installer): cover workspace archive build + import transport`
4. `docs: document workspace identity transport primitive and #20 scope split`

## Non-Goals

- No wiring into `installOpenClawOnRailway` or `provisionClientInstance` —
  deferred until the private client-profile repo's own #3 defines real
  identity-file content. Forcing a caller in now would mean threading
  placeholder content through production provisioning code for no
  functional benefit.
- No live Railway/live-instance test of `/setup/import` in this session —
  covered by an injected `postImport` dependency plus a real, offline
  `tar` build+extract round-trip (proves archive format correctness
  without a network call). A live smoke test is a separate, explicitly
  requested, billable step, matching `post-deploy-readiness`'s own
  precedent.
- No fetch-mock unit test of the default `postImport` implementation —
  matches existing precedent: `patchAllowedOrigins`'s and
  `approveOwnDevicePairing`'s default `fetch`-based implementations are
  likewise untested directly today, with behavior covered through their
  DI-injected paths instead. Noted explicitly so this doesn't read as an
  oversight later.
- No client-side path-traversal validation of `files` keys — the only
  caller is control-plane's own code passing fixed, hardcoded filenames
  (no untrusted input reaches this function); the wrapper's own
  `looksSafeTarPath` already validates tar-entry safety server-side on
  extraction.
- No resolution of whether file-seeded `IDENTITY.md` alone actually
  updates the dashboard's displayed identity chrome (the
  `agents.set-identity` sync-gap question from #20) — that needs a live
  test against real content, out of scope here.
- No change to the wrapper template itself
  (`vignesh07/clawdbot-railway-template`) — this plan only calls its
  already-existing, already-deployed `/setup/import` endpoint.
