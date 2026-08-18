# GitHub Installation Connector Transport — ACs

Source plan: `docs/plans/github-installation-connector/plan.md`. Delivers
the transport half of `[private-repo]#4` (the content half —
App registration, installation records — lives in that private repo,
not here).

Pass conditions are invariants over behavior (JWT structure/signature,
request shape, error propagation), never over a live GitHub call or a
config literal — no App exists yet to call live.

| AC | Plan ref | Role | Pass invariant | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-GHCONN-001 | D2 | `/devops` | `buildAppJwt(appId, privateKeyPem, now)` produces a 3-segment JWT whose header decodes to `{alg: "RS256", typ: "JWT"}`, whose payload decodes to `{iat, exp, iss}` with `iss === appId`, `iat` ≈60s before `now()`, `exp` ≤600s after `iat` — and whose signature verifies against the paired public key via `crypto.verify("RSA-SHA256", ...)`, proving round-trip correctness without a live GitHub call. | PASS - `github-installation-provisioning.ts:33-47`; test lines 26-45 verify via `crypto.verify` against a generated keypair and confirm exact iat/exp math. | PASS · spot-checked | |
| AC-GHCONN-002 | D2 | `/devops` | `mintInstallationToken(installationId, options)` calls `fetchImpl` exactly once, with method `POST`, URL `https://api.github.com/app/installations/{installationId}/access_tokens`, an `Authorization: Bearer <jwt>` header built from the same JWT `buildAppJwt` would produce for the same `appId`/`privateKeyPem`, `Accept: application/vnd.github+json`, and `X-GitHub-Api-Version: 2022-11-28` — the pinned API-version header matters most here since the response shape is unconfirmed live (see plan Background) and a future default-version shift is the one thing this header guards against. | PASS - `github-installation-provisioning.ts:84-91`; test lines 72-82 assert exactly one call, all header values, and that the sent JWT's `iss` matches. | PASS · spot-checked | |
| AC-GHCONN-003 | D2 | `/devops` | On a resolved-but-non-`ok` response, `mintInstallationToken` throws `GitHubProvisioningError` carrying the HTTP status, and never includes the response body in the thrown message (mirrors `OpenRouterProvisioningError`'s "never echo the body — it could in principle include a token" discipline). | PASS - `github-installation-provisioning.ts:62-70,93-97`; the `!response.ok` branch never calls `response.json()`, so the body is structurally unreachable, not just omitted. Test lines 91-101 confirm status propagates and message excludes leaked body content. | PASS · spot-checked | |
| AC-GHCONN-004 | D2 | `/devops` | On an `ok` response missing `token`, `expires_at`, or `permissions`, `mintInstallationToken` throws an `Error` naming the specific missing field — never returns an object with an `undefined` token. | PASS - `github-installation-provisioning.ts:106-114`; tests lines 103-136 cover all three fields missing individually, asserting the message names each. | PASS · spot-checked | |
| AC-GHCONN-005 | D2 | `/devops` | On a well-formed `ok` response, `mintInstallationToken` resolves `{token, expiresAt, permissions}` mapped directly from the response's `token`/`expires_at`/`permissions` fields, with no transformation that could silently drop or rename data. | PASS - `github-installation-provisioning.ts:116-120`; test lines 84-88 assert `toEqual` on the full mapped object. | PASS · spot-checked | |
| AC-COV-001 | D2 | `/devops` | `packages/openclaw-source-control-connector/package.json` exists with no `dependencies` key, an `"./github-installation-provisioning"` `exports` entry, and root `tsconfig.json`'s `references` array includes `{ "path": "./packages/openclaw-source-control-connector" }`. | PASS - confirmed via grep against `package.json` and `tsconfig.json`. | PASS · trust | |
| AC-TEST-001 | D3 | `/test-engineer` | Tests exist and pass for AC-GHCONN-001 through AC-GHCONN-005, imported via the package's `exports` path (`@openclaw-control-plane/openclaw-source-control-connector/github-installation-provisioning`), proving the `exports` entry from AC-COV-001 actually resolves — not just that the file exists. | PASS - test file imports via the package `exports` path (not a relative `src/` import); `npm run test` resolved and ran it, 6/6 passing. | PASS · spot-checked | |
| AC-DOCS-001 | D4 | `/project-manager` | `docs/architecture.md`'s Packages list gains an entry for `packages/openclaw-source-control-connector`; a note (there or in a dedicated doc) states the transport exists, is not yet wired into a CLI or any provisioning flow, and cross-references `[private-repo]#4` and this plan so the content/transport split is recorded in-repo — matching `workspace-identity-transport`'s `AC-DOCS-001` precedent. | PASS - `docs/architecture.md` Packages entry states "Not yet wired into a CLI or any provisioning flow" and cross-references both `[private-repo]#4` and this plan. | PASS · trust | |
| AC-REG-1 | — | `/test-engineer` | All existing tests pass. | PASS - `npm run test` → 26 files / 179 tests, 0 failures. | PASS · spot-checked (ran independently before and after sub-agent) | |
| AC-REG-2 | — | `/devops` | `npm run typecheck` and `npm run build` both pass clean (0 errors). | PASS - both `tsc -b` runs exit 0, zero output. | PASS · spot-checked (ran independently before and after sub-agent) | |

## Gate 1 — Plan ↔ ACs coverage (manual check, no repo validator script exists)

Every deliverable D2–D4 has at least one AC row above (D1 is this pair of
docs and is self-covering). No AC row references a deliverable ID outside
D1–D4. Independently re-confirmed by the Phase 3 verification sub-agent.

## Gate 2 — Anti-drift check (manual, no repo lint script exists)

No Pass-invariant cell pins a config literal (a specific token value, a
generated secret, an exact live response the plan couldn't have
confirmed) — each cell states behavior over the JWT's actual structure or
the injected `fetchImpl` stub's captured calls. AC-GHCONN-004/005
deliberately test against a hand-constructed mock response (not a live
call), consistent with the plan's Background note that GitHub's response
shape is unconfirmed live. Independently re-confirmed by the Phase 3
verification sub-agent.

## Phase 3 notes

No gaps found. The sub-agent independently re-derived every Pass
invariant from the actual source/test lines rather than trusting this
doc's prose, ran `npm run test`/`typecheck`/`build` itself (179/179
tests, 0 type errors, 0 build errors), and additionally checked two
things not written as their own AC rows: (1) the plan's Non-Goals list —
confirmed no `listInstallations`, repo-subset scoping, CLI, `/events`
audit wiring, profile-repo coupling, or GitLab module exists in the
diff, matching what was deliberately deferred; (2) token/secret
discipline — grepped both the source and test file for any
`console.`/`process.stdout`/`process.stderr`/`logger.` call, zero
matches, confirming the module's own header-comment discipline (never
log, print, or persist a minted token) actually holds.
