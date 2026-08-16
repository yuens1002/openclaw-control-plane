# Workspace Identity Transport ACs

Source plan: `docs/plans/workspace-identity-transport/plan.md`. Delivers
the transport half of issue #20 (content half lives in the private
`openClaw-CoT-agency-profile#3`).

Pass conditions are invariants over behavior (archive contents, auth
header presence, error propagation), never over a live Railway state or a
config literal.

| AC | Plan ref | Role | Pass invariant | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-XPORT-001 | D2 | `/devops` | `buildWorkspaceArchive({...})` produces a gzip'd tar whose entries, once extracted with the real `tar` library into a scratch directory, reproduce every input file byte-for-byte under `workspace/<name>` — and contain no other entries (in particular, no `BOOTSTRAP.md`, since callers omit it deliberately and this module must not inject anything not given to it). | | | |
| AC-XPORT-002 | D2 | `/devops` | `importWorkspaceFiles` calls `dependencies.postImport` (or the default) with the archive `buildWorkspaceArchive` would have produced for the same `files` input, and with an `auth` value equal to what was passed in — the caller's credentials and content reach the transport layer unmodified, not reconstructed or partially applied. | | | |
| AC-XPORT-003 | D2 | `/devops` | When `postImport` resolves with `ok: false`, `importWorkspaceFiles` throws an `Error` whose message includes both the returned HTTP status and response body text, and makes no retry — `/setup/import` stops the gateway as a side effect of being called at all, so silently retrying on failure risks repeated gateway restarts. | | | |
| AC-XPORT-004 | D2 | `/devops` | The default `postImport` implementation sends `content-type: application/gzip` and an `authorization: Basic ...` header built from `basicAuthHeader(auth)` (reused unchanged from `setup-auth.ts`) — not `application/json`, not `multipart/form-data`, matching the wrapper's own confirmed contract (`server.js`'s `readBodyBuffer`, no `express.json()` on this route). Verified by reading the source; per the plan's Non-Goals, this is not covered by a `fetch`-mock unit test, matching existing precedent for the sibling modules' own default implementations. | | | |
| AC-XPORT-005 | D2 | `/devops` | The default `postImport`'s success check is HTTP status (`response.ok`) only, with no JSON parsing of the response body — this is a deliberate divergence from `patchAllowedOrigins`/`approveOwnDevicePairing`'s JSON-`ok`-flag check, correct because `/setup/import` returns plain text with no JSON `ok` field at all (confirmed from `server.js`), not a regression of the gap Copilot's #22 review caught on the other two endpoints. | | | |
| AC-COV-001 | D2 | `/devops` | `packages/openclaw-railway-installer/package.json` gains a `tar` dependency and an `"./import-workspace-files"` `exports` entry pointing at `./src/import-workspace-files.ts`, matching every other module's export-per-file convention in this package. | | | |
| AC-TEST-001 | D3 | `/test-engineer` | Mocked and round-trip tests exist and pass for AC-XPORT-001 through AC-XPORT-003 (archive round-trip, injected-dependency call-through, and thrown-error-on-failure), imported via the package's `exports` path (`@openclaw-control-plane/openclaw-railway-installer/import-workspace-files`) — proving the `exports` entry from AC-COV-001 actually resolves, not just that the file exists. | | | |
| AC-DOCS-001 | D4 | `/project-manager` | `deploy/openclaw-railway/README.md` (or an equivalent docs location) notes that a `importWorkspaceFiles` transport primitive now exists for seeding workspace identity files via `/setup/import`, that it is not yet wired into either provisioning flow, and cross-references issue #20 and the private `openClaw-CoT-agency-profile#3` so the content/transport split is recorded in-repo. | | | |
| AC-REG-1 | — | `/test-engineer` | All existing tests pass. | | | |
| AC-REG-2 | — | `/devops` | `npm run typecheck` and `npm run build` both pass clean (0 errors) — the backstop for the `tar`/`@types/tar` dependency question left open in the plan's Design section. | | | |

## Gate 1 — Plan ↔ ACs coverage (manual check, no repo validator script exists)

Every deliverable D2–D4 has at least one AC row above (D1 is this pair of
docs and is self-covering). No AC row references a deliverable ID outside
D1–D4.

## Gate 2 — Anti-drift check (manual, no repo lint script exists)

No Pass-invariant cell above pins a config literal (a specific domain
string, a generated secret value, an exact response-text literal beyond
what the plan's Background section already confirmed from source) — each
cell states behavior over the archive's actual contents or the injected
stub's captured calls instead.
