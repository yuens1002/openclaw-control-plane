# Post-Deploy Readiness ACs

Source plan: `docs/plans/post-deploy-readiness/plan.md`. Resolves issue #18
items 3, 4, 5.

Pass conditions are invariants over behavior (call sequence, auth header
presence, idempotency), never over a live Railway state, a specific domain
string, or a config literal.

| AC | Plan ref | Role | Pass invariant | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-READY-001 | D2 | devops | `installOpenClawOnRailway`'s readiness poll issues an authenticated `GET` to `${baseUrl}/setup/api/status` with a Basic `Authorization` header built from the resolved setup credentials — not an unauthenticated `GET` to `/setup/healthz` — and treats any non-200 response (in particular 401) as not-yet-ready, never as success. | | | |
| AC-READY-002 | D2 | devops | The pre-existing `healthCheck` export and its `dependencies.healthCheck?` injection point are untouched by this change — `checkSetupStatus` is additive, not a repurposing of `healthCheck`. | | | |
| AC-CORS-001 | D3 | devops | `patchAllowedOrigins` GETs `/setup/api/config/raw`, and issues **no POST at all** when `gateway.controlUi.allowedOrigins` already contains the instance's own `https://<domain>` origin. | | | |
| AC-CORS-002 | D3 | devops | When a write does happen, the POST body preserves every other field and every pre-existing `allowedOrigins` entry from the fetched config content unmodified — only the new origin is appended. | | | |
| AC-PAIR-001 | D4 | devops | `approveOwnDevicePairing` GETs `/setup/api/devices/pending`; with exactly one `requestId`, it POSTs `/setup/api/devices/approve` with that id; with zero, it makes no POST call. | | | |
| AC-PAIR-002 | D4 | devops | With more than one pending `requestId`, `approveOwnDevicePairing` throws an explicit ambiguous-pending-devices error and makes no approve call, rather than guessing or approving all of them. | | | |
| AC-WIRE-001 | D5 | devops | `installOpenClawOnRailway` runs the three steps in order — readiness, then allowedOrigins patch, then device-pairing approve — after the existing domain-fix step, and `InstallResult` gains `patchedAllowedOrigins: boolean` and `approvedDeviceRequestId?: string` reflecting what actually happened on that run. | | | |
| AC-TEST-001 | D6 | test-engineer | Mocked tests exist and pass for: the auth-gated readiness poll's header/endpoint (AC-READY-001), the allowedOrigins patch's idempotency and merge-safety (AC-CORS-001/002), and all three pending-device cases — zero/one/many (AC-PAIR-001/002) — each against an injected fetch/dependency stub, no live Railway or live OpenClaw instance. | | | |
| AC-DOCS-001 | D7 | project-manager | README/deploy docs describe the three new post-deploy steps (readiness, CORS patch, pairing approve) and why each is needed, and explicitly cross-reference #16 (owning items 1/2/7) and #20 (Part 2) so the issue-#18 scope split is recorded in-repo. | | | |

## Gate 1 — Plan ↔ ACs coverage (manual check, no repo validator script exists)

Every deliverable D2–D7 has at least one AC row above (D1 is this pair of
docs and is self-covering). No AC row references a deliverable ID outside
D1–D7.

## Gate 2 — Anti-drift check (manual, no repo lint script exists)

No Pass-invariant cell above pins a config literal (a specific domain
string, a generated secret value, a request-id literal) — each cell states
behavior over the injected stub's captured calls instead.
