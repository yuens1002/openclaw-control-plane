# Workspace Identity Transport ACs

Source plan: `docs/plans/workspace-identity-transport/plan.md`. Delivers
the transport half of issue #20 (content half lives in the private
client-profile repo's own issue #3).

Pass conditions are invariants over behavior (archive contents, auth
header presence, error propagation), never over a live Railway state or a
config literal.

| AC | Plan ref | Role | Pass invariant | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-XPORT-001 | D2 | `/devops` | `buildWorkspaceArchive({...})` produces a gzip'd tar whose entries, once extracted with the real `tar` library into a scratch directory, reproduce every input file byte-for-byte under `workspace/<name>` — and contain no other entries (in particular, no `BOOTSTRAP.md`, since callers omit it deliberately and this module must not inject anything not given to it). | PASS - `import-workspace-files.ts:55-73`; test round-trips via real `tar.x`, asserts byte-for-byte content + set-equality of entries + a dedicated no-`BOOTSTRAP.md` case. 4/4 tests run green. | PASS - confirmed by reading the same lines and test file. | |
| AC-XPORT-002 | D2 | `/devops` | `importWorkspaceFiles` calls `dependencies.postImport` (or the default) with the archive `buildWorkspaceArchive` would have produced for the same `files` input, and with an `auth` value equal to what was passed in — the caller's credentials and content reach the transport layer unmodified, not reconstructed or partially applied. | PASS - `import-workspace-files.ts:34-48`; test captures `auth`/`archive` from injected `postImport`, asserts `toEqual(AUTH)` and independently re-extracts the captured archive to confirm content match. | PASS - confirmed. | |
| AC-XPORT-003 | D2 | `/devops` | When `postImport` resolves with `ok: false`, `importWorkspaceFiles` throws an `Error` whose message includes both the returned HTTP status and response body text, and makes no retry — `/setup/import` stops the gateway as a side effect of being called at all, so silently retrying on failure risks repeated gateway restarts. | PASS - `import-workspace-files.ts:44-46` throws with status+body, single call, no retry loop; test asserts thrown message + `callCount === 1`. | PASS - confirmed. | |
| AC-XPORT-004 | D2 | `/devops` | The default `postImport` implementation sends `content-type: application/gzip` and an `authorization: Basic ...` header built from `basicAuthHeader(auth)` (reused unchanged from `setup-auth.ts`) — not `application/json`, not `multipart/form-data`, matching the wrapper's own confirmed contract (`server.js`'s `readBodyBuffer`, no `express.json()` on this route). Verified by reading the source; per the plan's Non-Goals, this is not covered by a `fetch`-mock unit test, matching existing precedent for the sibling modules' own default implementations. | PASS - `import-workspace-files.ts:75-87`; source-verified, no fetch-mock test, matching the documented Non-Goal exactly. | PASS - confirmed. | |
| AC-XPORT-005 | D2 | `/devops` | The default `postImport`'s success check is HTTP status (`response.ok`) only, with no JSON parsing of the response body — this is a deliberate divergence from `patchAllowedOrigins`/`approveOwnDevicePairing`'s JSON-`ok`-flag check, correct because `/setup/import` returns plain text with no JSON `ok` field at all (confirmed from `server.js`), not a regression of the gap Copilot's #22 review caught on the other two endpoints. | PASS - independently re-fetched `vignesh07/clawdbot-railway-template@main`'s `server.js` directly (not just trusting the plan) and confirmed both the success path (`res.type("text/plain").send("OK - imported...")`) and failure path (`res.status(500).type("text/plain").send(String(err))`) are plain text with no `ok` field; cross-checked that the sibling CORS/pairing endpoints genuinely do return JSON `{ok}` so the claimed divergence is real, not a rationalization. | PASS - independently confirmed the same via my own earlier direct read of `server.js` while drafting the plan; two independent reads agree. | |
| AC-COV-001 | D2 | `/devops` | `packages/openclaw-railway-installer/package.json` gains a `tar` dependency and an `"./import-workspace-files"` `exports` entry pointing at `./src/import-workspace-files.ts`, matching every other module's export-per-file convention in this package. | PASS - `package.json:21` (`"tar": "^7.5.22"`), `package.json:12` (exports entry). | PASS - confirmed. | |
| AC-TEST-001 | D3 | `/test-engineer` | Mocked and round-trip tests exist and pass for AC-XPORT-001 through AC-XPORT-003 (archive round-trip, injected-dependency call-through, and thrown-error-on-failure), imported via the package's `exports` path (`@openclaw-control-plane/openclaw-railway-installer/import-workspace-files`) — proving the `exports` entry from AC-COV-001 actually resolves, not just that the file exists. | PASS - test file imports via the package `exports` path, not a relative `src/` import; `npx vitest run tests/openclaw-railway-import-workspace-files.test.ts` → 4/4 pass; each test body asserts a real invariant, none tautological. | PASS - confirmed. | |
| AC-DOCS-001 | D4 | `/project-manager` | `deploy/openclaw-railway/README.md` (or an equivalent docs location) notes that a `importWorkspaceFiles` transport primitive now exists for seeding workspace identity files via `/setup/import`, that it is not yet wired into either provisioning flow, and cross-references issue #20 and the private client-profile repo's own issue #3 so the content/transport split is recorded in-repo. | PASS - `deploy/openclaw-railway/README.md`, "Workspace identity file transport (not yet wired in)" section names the function, states it's unwired, cross-references both #20 and profile-repo #3. | PASS - confirmed. | |
| AC-REG-1 | — | `/test-engineer` | All existing tests pass. | PASS - `npm run test` → 22 files / 132 tests, 0 failures. | PASS - confirmed. | |
| AC-REG-2 | — | `/devops` | `npm run typecheck` and `npm run build` both pass clean (0 errors) — the backstop for the `tar`/`@types/tar` dependency question left open in the plan's Design section. | PASS - both `tsc -b` runs exit 0; confirmed `tar` ships its own `.d.ts` files (`dist/{esm,commonjs}`), so `@types/tar` is correctly omitted. | PASS - confirmed. | |

## Gate 1 — Plan ↔ ACs coverage (manual check, no repo validator script exists)

Every deliverable D2–D4 has at least one AC row above (D1 is this pair of
docs and is self-covering). No AC row references a deliverable ID outside
D1–D4. Independently re-confirmed by the Phase 3 verification sub-agent,
which also verified all four Commit Schedule commits exist verbatim in
`git log`.

## Gate 2 — Anti-drift check (manual, no repo lint script exists)

No Pass-invariant cell above pins a config literal (a specific domain
string, a generated secret value, an exact response-text literal beyond
what the plan's Background section already confirmed from source) — each
cell states behavior over the archive's actual contents or the injected
stub's captured calls instead. Independently re-confirmed by the Phase 3
verification sub-agent.

## Phase 3 notes

No real gaps found. The one AC flagged as highest-risk for a
plan-trusting rubber stamp — AC-XPORT-005's claim that `/setup/import`
returns plain text with no JSON `ok` field, unlike its sibling endpoints —
was independently re-derived by the verification sub-agent from a fresh
fetch of `vignesh07/clawdbot-railway-template@main`'s `server.js`, not
just trusted from the plan's Background section, and confirmed correct.
Full test suite (132 tests), typecheck, and build all pass clean.

One documented, intentional gap (not a defect): `defaultPostImport`'s
header-setting has no `fetch`-mock unit test, matching existing precedent
for `patchAllowedOrigins`/`approveOwnDevicePairing`'s own untested
defaults (see plan Non-Goals). Worth a live/staging smoke test before this
primitive is wired into a real provisioning flow, but that's explicitly
out of scope for this transport-only iteration.
