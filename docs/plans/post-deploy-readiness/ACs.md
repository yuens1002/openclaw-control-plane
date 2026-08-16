# Post-Deploy Readiness ACs

Source plan: `docs/plans/post-deploy-readiness/plan.md`. Resolves issue #18
items 3, 4, 5.

Pass conditions are invariants over behavior (call sequence, auth header
presence, idempotency), never over a live Railway state, a specific domain
string, or a config literal.

| AC | Plan ref | Role | Pass invariant | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-READY-001 | D2 | devops | `installOpenClawOnRailway`'s readiness check issues an authenticated `GET` to `${baseUrl}/setup/api/status` with a Basic `Authorization` header built from the resolved setup credentials — not an unauthenticated `GET` to `/setup/healthz` — and treats any non-200 response (in particular 401) as not-yet-ready, never as success. | PASS - `index.ts:228-232` targets `/setup/api/status`; default `checkSetupStatus` sends `authorization: basicAuthHeader(auth)`; non-200 doesn't count as ready. Verified against source, not just the DI mock. | PASS - confirmed by reading the same lines; `openclaw-railway-installer-readiness.test.ts` covers both the 200 and 401 cases. | |
| AC-READY-002 | D2 | devops | The readiness gate is fully replaced, not duplicated: the pre-existing unauthenticated `healthCheck` helper and its `dependencies.healthCheck?` injection point are removed once `checkSetupStatus` takes over the only call site that used them — a caller can no longer wire up a healthcheck that silently does nothing. (Revised from the plan's original "leave `healthCheck` untouched" — Phase 3 verification found that left it as dead, misleading code once its one call site moved.) | FAIL (as first implemented) - sub-agent found `healthCheck()`/`dependencies.healthCheck?` were left as unreachable dead code once the call site moved, a real footgun for any caller still passing that field. | PASS (after fix) - removed both; TS excess-property-checking caught all five now-stale test mocks, which were also removed/replaced. Re-ran typecheck + full suite green. This AC's own wording was revised in the same commit to describe the corrected, shipped behavior rather than the stale plan intent. | |
| AC-READY-003 | D2 | devops | The readiness check is a poll, not a single attempt: `waitForSetupReady` retries `checkSetupStatus` (reusing the resolved `pollSeconds`/`timeoutMinutes`) until it returns 200 or the timeout elapses, since newly-rotated setup credentials can take a few seconds to propagate after the deployment itself reaches `SUCCESS`. | FAIL (as first implemented) - Copilot's PR review caught that the readiness check was a single `GET` that failed immediately on any non-200, despite the plan/comment describing it as a poll. | PASS (after fix) - added `waitForSetupReady` (do-while poll matching `waitForSuccessfulService`'s shape); new test asserts 3 attempts (401, 401, 200) before succeeding. | |
| AC-CORS-001 | D3 | devops | `patchAllowedOrigins` GETs `/setup/api/config/raw`, and issues **no POST at all** when `gateway.controlUi.allowedOrigins` already contains the instance's own `https://<domain>` origin. | PASS - `patch-allowed-origins.ts:40-42`, `existingOrigins.includes(origin)` short-circuits before any `postConfigRaw` call. Test: "is idempotent" asserts `postCalls === 0`. | PASS - confirmed by reading the same lines and the test. | |
| AC-CORS-002 | D3 | devops | When a write does happen, the POST body preserves every other field and every pre-existing `allowedOrigins` entry from the fetched config content unmodified — only the new origin is appended. | PASS - merge mutates the parsed `config` object in place via `asRecord`, then re-serializes the whole object, not a reconstructed subset; sibling keys and existing array order survive. Test asserts `written.agents.defaults.model` survives and origin order is `[existing, new]`. | PASS - confirmed by reading `patch-allowed-origins.ts:33-45` and the test's fixture. | |
| AC-CORS-003 | D3 | devops | `patchAllowedOrigins` checks the wrapper's JSON-level `ok` flag on both the GET and the POST response, not just the HTTP status — a 2xx response carrying `{ok:false}` throws rather than being treated as success (or, on GET, silently parsed as if it were valid content). | FAIL (as first implemented) - Copilot's PR review caught that only `response.ok` (HTTP status) was checked; a 2xx-with-`ok:false` body would have been treated as success. | PASS (after fix) - caller now checks `getResult.ok`/`postResult.ok` explicitly; two new tests assert both throw with an `ok:false`-shaped body even though the HTTP-level mock always "succeeds." | |
| AC-PAIR-001 | D4 | devops | `approveOwnDevicePairing` GETs `/setup/api/devices/pending`; with exactly one `requestId`, it POSTs `/setup/api/devices/approve` with that id; with zero, it makes no POST call. | PASS - `approve-own-device.ts:24-28,39-43`; test covers zero (no-op) and one (approves, returns id). | PASS - confirmed. | |
| AC-PAIR-002 | D4 | devops | With more than one pending `requestId`, `approveOwnDevicePairing` throws an explicit ambiguous-pending-devices error and makes no approve call, rather than guessing or approving all of them. | PASS - `approve-own-device.ts:29-37` throws "Found N pending device pairing requests"; test asserts throw + 0 approve calls. | PASS - confirmed. | |
| AC-PAIR-003 | D4 | devops | `approveOwnDevicePairing` checks the wrapper's JSON-level `ok` flag on both the pending-devices listing and the approve call, not just the HTTP status. | FAIL (as first implemented) - same class of gap as AC-CORS-003, also caught by Copilot's PR review. | PASS (after fix) - caller now checks `pending.ok`/`approved.ok` explicitly; two new tests assert both throw. | |
| AC-WIRE-001 | D5 | devops | `installOpenClawOnRailway` runs the three steps in order — readiness, then allowedOrigins patch, then device-pairing approve — after the existing domain-fix step, and `InstallResult` gains `patchedAllowedOrigins: boolean` and `approvedDeviceRequestId?: string` reflecting what actually happened on that run. | PASS (call order/types confirmed from source) but **under-tested**: no test asserted the actual `InstallResult` field values or call order at verification time. | PASS (after fix) - added two dedicated tests: call order via a shared marker array, and both the "patched + approved" and "nothing to do" `InstallResult` shapes. | |
| AC-TEST-001 | D6 | test-engineer | Mocked tests exist and pass for: the auth-gated readiness poll's header/endpoint/retry behavior (AC-READY-001/003), the allowedOrigins patch's idempotency, merge-safety, and `ok:false` handling (AC-CORS-001/002/003), and all pending-device cases — zero/one/many/`ok:false` (AC-PAIR-001/002/003) — each against an injected fetch/dependency stub, no live Railway or live OpenClaw instance. | PASS - all named test files exist and pass; assertions check the claimed invariants (call presence/absence, auth object equality, config-content preservation, ambiguity throw, retry-count, ok:false rejection), not incidental literals — no brittle-literal trap found. | PASS - full suite: 18 files / 109 tests green after Copilot-review fixes; `tsc -b` clean. | |
| AC-DOCS-001 | D7 | project-manager | README/deploy docs describe the three new post-deploy steps (readiness, CORS patch, pairing approve) and why each is needed, and explicitly cross-reference #16 (owning items 1/2/7) and #20 (Part 2) so the issue-#18 scope split is recorded in-repo. | PASS - `deploy/openclaw-railway/README.md` documents all three steps and why; cross-references #16 and #20. | PASS - confirmed by reading the section. | |

## Gate 1 — Plan ↔ ACs coverage (manual check, no repo validator script exists)

Every deliverable D2–D7 has at least one AC row above (D1 is this pair of
docs and is self-covering). No AC row references a deliverable ID outside
D1–D7. Independently re-confirmed by the Phase 3 verification sub-agent:
no orphans either direction.

## Gate 2 — Anti-drift check (manual, no repo lint script exists)

No Pass-invariant cell above pins a config literal (a specific domain
string, a generated secret value, a request-id literal) — each cell states
behavior over the injected stub's captured calls instead. Independently
re-confirmed by the Phase 3 verification sub-agent.

## Phase 3/4 notes

Two real gaps were found during verification and fixed before this doc was
finalized:

1. **AC-READY-002** — implementing D2 by simply swapping the readiness call
   site left the old `healthCheck` helper and its `dependencies.healthCheck?`
   field as dead code, which is a worse outcome than either fully removing
   it or genuinely keeping it wired to something. Fixed by removing both;
   this AC's wording was revised in the same commit to match the corrected,
   shipped design rather than the plan's original (less good) intent —
   the same "AC/plan authoring gap, closed by the loop working as designed"
   pattern this repo's retro history has flagged before.
2. **AC-WIRE-001** — the integration wiring (D5) was correct by inspection
   but had no test asserting the actual `InstallResult` output values or
   step call order. Closed with two new tests rather than left as a gap.

One additional low-cost gap (zero direct unit coverage of `basicAuthHeader`,
since every other test exercises it only indirectly via dependency
injection) was closed with a one-assertion unit test, even though it wasn't
tied to a specific AC — cheap enough not to leave as a known gap.

Not fixed, judged genuinely out of scope: `asRecord` in
`patch-allowed-origins.ts` silently replaces a non-object `gateway`/
`controlUi` value rather than erroring. No AC covers this because a
freshly machine-written `openclaw.json` having a corrupt `gateway` key as
a non-object is not a realistic scenario for this internal tool acting on
its own just-provisioned instance — adding error handling for it would be
speculative, not defensive.

## Post-`/review` Copilot findings (PR #22)

Copilot's automated PR review caught three real issues this workflow's own
gates and the Phase 3 sub-agent missed — all fixed before merge, tracked as
AC-READY-003 and AC-CORS-003/AC-PAIR-003 above:

1. The readiness check was a single attempt, not a poll, despite the
   plan/code comment describing it as one — a direct miss against this
   repo's own `/devops` retro principle ("poll the authenticated endpoint
   ... in a retry loop"), which this feature's own comment quoted without
   actually implementing the retry.
2. `patchAllowedOrigins` and `approveOwnDevicePairing` both checked only
   the HTTP status, not the wrapper's JSON-level `ok` flag — not
   exploitable against the wrapper's actual known contract (every `ok:false`
   response also uses a non-2xx status in the real implementation, confirmed
   by reading `vignesh07/clawdbot-railway-template`'s `server.js`), but a
   reasonable defense-in-depth given the field was already being parsed and
   ignored.

None of these were caught by the Phase 3 sub-agent or the `/review` pass —
both verified the code against its own stated design faithfully, but
neither independently re-derived "should this poll" or "should this check
the JSON body too" from first principles the way an adversarial reviewer
does. Worth noting for `/retro`.
