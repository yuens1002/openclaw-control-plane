# GitHub webhook signature verification — Review

**Plan:** `docs/plans/github-webhook-verify/plan.md`
**ACs:** `docs/plans/github-webhook-verify/ACs.md`
**Issue:** [#108](https://github.com/yuens1002/openclaw-control-plane/issues/108)

## Verdict

Ready to merge. 18/18 ACs PASS. Two real bugs were found and fixed: one
during Verify (AC-FN-2, the route was functionally dead), one during
`/ocr-review` Phase 4.4 (a connection-reset instead of a clean 400 on
oversize/slow bodies). All 11 low-severity `/ocr-review` findings were also
applied at the operator's request. Everything else passed on independent
evidence across two full verify passes plus the ocr-review pass. 310 tests,
precheck clean.

## `/ocr-review` (Phase 4.4)

Three parallel bundles (Dockerfile; the two new `.mjs` scripts; the two test
files, which OCR's default ruleset excludes by path and which were
dispatched as an extra adversarial bundle per this skill's own gotcha about
test-file coverage). 16 findings: 1 high, 4 medium, 11 low. All
high/medium fixed and re-verified; low findings recorded below, not applied.

**High — fixed.** No test modeled a request stream that had already ended
before `readRawBody` attached its listeners — exactly the shape of the
AC-FN-2 bug, just never exercised directly. Added a test that drains a fake
stream first and asserts `readRawBody` rejects immediately (not via the 10s
timeout), paired with a new fast-fail guard (`req.readableEnded`) in the
module itself — defense in depth against a future re-anchoring regression.

**Medium — fixed, empirically re-verified.** `readRawBody` called
`req.destroy()` on a limit/timeout rejection *before* the handler could send
its 400 response. On a real socket this tears the connection down first, so
the client sees `ECONNRESET`, not a clean `400` — confirmed against a real
`http.createServer()` both before the fix (connection reset) and after
(clean `400`, `Connection: close`, verified via `node
scratchpad/repro-oversize-fix.mjs`-equivalent). Fixed by no longer
destroying on limit/timeout — the handler now responds first and closes the
now-idle connection only after the response is flushed
(`res.once("finish", ...)`).

**Medium — fixed (3 test-coverage gaps).** (1) The `GITHUB_WEBHOOK_SECRET`
env-var fallback — the actual production code path, since the injected
route calls the handler with no options — was only tested negatively; added
a positive-path test. (2) The fake request always emitted exactly one data
chunk, so multi-chunk accumulation, `timeoutMs`, and the stream-error path
were unexercised; added coverage for all three using a real `Readable`
directly rather than the shared fixture. (3) `AC-TST-4`'s apply-once test
asserted only the route registration, not the import line, unlike its
scoped-export sibling; added the missing assertion.

**Low — all 11 subsequently applied, at the operator's request:**

- Corrected both overstated Dockerfile comments: this route never actually
  reaches `requireDashboardAuth` (it responds and returns before the
  catch-all that applies that gate); `express.json()` drains the stream
  only for JSON content types, not unconditionally (true for every real
  GitHub delivery, which is always `application/json`, but worth stating
  precisely so a differently-shaped future repro isn't misled).
- `patch-wrapper-github-webhook.mjs`'s own file header now names
  `express.json` as the load-bearing anchor, matching the fix already made
  to the module header in `880ed5a`.
- The handler's JSDoc no longer presents "non-POST → 405" as reachable
  route behavior — documented as defensive-only, since `app.post(...)`
  registration already filters to POST before the handler runs.
- Added `GITHUB_WEBHOOK_MAX_BODY_BYTES` as an env override for the 1 MiB
  body cap, mirroring `wrapper-state-export.mjs`'s
  `OPENCLAW_STATE_EXPORT_MAX_BYTES` pattern exactly (throws on a malformed
  override rather than silently falling back), with its own test coverage.
- The tar-import "already applied" guard now keys off a unique,
  adjacency-independent marker line instead of the full multi-line block,
  so a sibling patch script inserting at the same anchor can't blind it.
- Fixed the pre-existing, unrelated `EXPOSE 8080` / missing `ENV PORT` gap
  (a platform that fails to inject `PORT` would otherwise leave the
  container listening on `:3000` while advertising `:8080`) — in scope
  here because this diff adds a new public-facing route whose delivery
  failures would otherwise surface only as opaque GitHub-side timeouts.
- Extended the patch-script tests: a duplicated-anchor case for
  `patch-wrapper-github-webhook` (previously only covered for its
  siblings), and the no-target-path usage test now covers all three
  scripts.
- Removed the stale "D1 is authored in parallel" comment from the test
  file's header.

All fixes re-verified: 310 tests, precheck clean, Gate 1 still 0 orphans.

## Deliverables ↔ code

| Deliverable | File(s) | Status |
|---|---|---|
| D1 | `scripts/wrapper-github-webhook-verify.mjs` | Implemented exactly to the plan's module contract (function names/signatures/behavior). |
| D2 | `scripts/patch-wrapper-github-webhook.mjs`, `Dockerfile` | Implemented, then corrected mid-review (see below). |
| D3 | `tests/openclaw-railway-wrapper-patches.test.ts` (extended), `tests/wrapper-github-webhook-verify.test.ts` (new) | Implemented; extended again to close a gap Verify found (missing-header handler test) and to track D2's anchor fix. |
| D4 | `docs/plans/github-webhook-verify/plan.md` | This plan, corrected mid-review. |
| D5 | `docs/plans/github-webhook-verify/ACs.md` | This ACs doc, corrected mid-review. |
| D6 | `docs/plans/github-webhook-verify/review.md` | This file. |
| D7 | Issue [#108](https://github.com/yuens1002/openclaw-control-plane/issues/108) | Filed, hygiene-checked twice independently (zero leaked private identifiers). |

## The bug Verify found, and the fix

**AC-FN-2 failed on the first verify pass.** The route was registered
immediately before the wrapper's catch-all `app.use(requireDashboardAuth,
...)` proxy — which satisfies "registered before the catch-all" as a literal
reading, but the wrapper also registers a *global* `app.use(express.json({
limit: "1mb" }))` body parser earlier still, and nothing in the original
patch anchored around it. Express dispatches in registration order: the
body parser ran first, drained the request stream via its own `data`/`end`
listeners, and the injected route's own `readRawBody` then attached listeners
to an already-ended stream that never fired — every real request hung to its
10-second timeout and returned `400`. The verify agent proved this
empirically against the real pinned wrapper source (downloaded fresh, not a
cached copy), with a negative control: reverting the anchor to its original
(buggy) position reproduced the exact same timeout/400 on demand, confirming
the test genuinely discriminates rather than being insensitive to placement.

**Fix:** re-anchor `scripts/patch-wrapper-github-webhook.mjs`'s route
registration on `app.use(express.json({ limit: "1mb" }));` instead of on the
catch-all. The route is still registered ahead of the catch-all (transitively
— it's ahead of everything between it and the proxy), but now also ahead of
the body parser, so it reads the raw body itself before anything else can
touch the stream. A second, independent verify pass (fresh network download
of the pinned wrapper, fresh HTTP probes against a booted real
`server.js`) confirmed: valid signature → `200` in ~5ms, invalid → `401` in
~1.5ms, missing header → `401` in ~1.3ms — no timeouts.

Everything downstream of the anchor was also corrected to match: the test
fixture (`SYNTHETIC_SERVER_JS`) now carries the `express.json(...)` anchor
line the patch script actually targets, with placement and missing-anchor
assertions checked against it; `plan.md`/`ACs.md` describe the real anchor;
the Dockerfile comment block and `README.md` explain *why* the anchor had to
be the body parser and not the catch-all, so a future patch touching this
area doesn't reintroduce the same class of bug.

## Post-fix polish (from the second verify pass, non-blocking but applied)

- `scripts/wrapper-github-webhook-verify.mjs`'s module header still described
  the old (buggy) anchor after the fix landed elsewhere — corrected.
- `verifyGithubSignature` returned `false` for a falsy `headerValue` but
  would have thrown on a non-string, truthy `headerValue` (e.g. a number) —
  added an explicit `typeof headerValue !== "string"` guard. Unreachable
  through the real route (Express normalizes single-value headers to
  strings) but cheap, and the module's own contract promises "never throws."
- Added a dedicated `handleGithubWebhookVerify` test for a POST with no
  signature header at all (previously covered only at the
  `verifyGithubSignature` unit level, not at the handler level).

## ACs ↔ tests

All 18 AC rows in `ACs.md` map to a real, currently-passing check:
`AC-FN-*`/`AC-DOC-*`/`AC-COV-*` to code review (each independently
re-derived by the verify agent, not inferred from the implementer's own
claims), `AC-TST-*`/`AC-REG-*` to `npm test`/`npm run precheck`, both run
directly by the verify agent rather than trusted from a prior report. No
AC's `Pass` cell pins a config-literal — every functional row states a
relation (timing-safe match, drains-before-listener behavior, guard ordering)
rather than an exact string.

## Docs drift

None outstanding. `README.md`'s claim about the anchor and about `405`
being reachable through the registered route was corrected during the fix
(the `405` branch is real, defensive code in the handler, but is
unreachable through `app.post(...)`'s own method filtering — documented
honestly rather than overclaimed).

## Hygiene

Checked twice, independently, against the *live* GitHub issue (not the
draft) via `gh issue view 108 --repo yuens1002/openclaw-control-plane`: zero
hits for the private repo name, org name, `#41`, or any Railway/hostname
identifier. The `Dockerfile`/`README.md` diff was separately grepped for the
same terms — clean.

## Recommendations / follow-ups (not blocking this PR)

- `patch-wrapper-github-webhook.mjs`'s "already-applied" guard for the
  `tar` import shares an anchor with `patch-wrapper-scoped-export.mjs`'s own
  tar-import guard; after both apply, only the script that ran *last* has a
  live already-applied check for that shared line. The Dockerfile's fixed
  build order makes this moot today, but worth naming if a third script
  ever shares that anchor.
- The oversized-body path calls `req.destroy()`, which on a real socket
  produces a connection reset rather than a clean `400` response to the
  client; the unit test's fake `req` doesn't model socket-level destroy
  semantics, so it observes `400` where a real GitHub delivery would see a
  failed delivery by a different mechanism. Same practical outcome
  (delivery fails), different observable shape — not worth the complexity
  of a more realistic fake for this narrow a case.

## /retro inputs

- **Process lesson, not a code lesson:** a green synthetic-fixture test
  suite and a correct implementer report both agreed the route was placed
  correctly, and both were wrong about *why* it mattered — the fixture
  never modeled the wrapper's global body parser at all, so nothing in
  Implement's own test-writing could have caught this class of gap. This is
  exactly the `agentic-orca` retro rule about sibling-parity gaps needing an
  external, whole-source-comparing check, not a per-deliverable one — and it
  held here even with a solid, adversarial unit-test suite already in place.
  The fix was to have Verify replay the patch against the *real* pinned
  upstream source, not just the synthetic fixture — which the Verify prompt
  already asked for, and which is the reason this was caught before merge
  rather than in production.
