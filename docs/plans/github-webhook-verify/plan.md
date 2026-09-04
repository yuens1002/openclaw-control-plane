# GitHub webhook signature verification — Plan

Branch: `feat/github-webhook-verify`
Source: [issue #108](https://github.com/yuens1002/openclaw-control-plane/issues/108) (implementation), cross-referenced from a private governance issue that owns App registration, secret provisioning, and live-verification sign-off.

## Summary

Add one wrapper-owned HTTP route, `POST /hooks/github-webhook-verify`, that
verifies a GitHub App webhook delivery's `X-Hub-Signature-256` HMAC-SHA256
signature and responds 200/401 accordingly — no dispatch, no agent
involvement, no gateway process involvement. This is the receiving endpoint
a GitHub App's native webhook delivery needs; nothing in the vendored
wrapper or upstream OpenClaw currently verifies this signature scheme.

## Current State

- The wrapper's `requireDashboardAuth` gate already exempts any path
  starting with `/hooks` from Basic Auth (`Dockerfile` `sed` patch, "allow
  OpenClaw webhook endpoints to bypass dashboard auth") — confirmed by
  downloading the pinned wrapper commit's `src/server.js`: `/hooks*` is not
  one of the wrapper's own registered routes, just exempted then proxied
  through to the OpenClaw gateway. Any path under `/hooks` is already
  publicly reachable without Basic Auth today.
- Upstream OpenClaw ships a generic `/hooks` gateway and a bundled
  `webhooks` plugin, but both authenticate with a static shared secret
  compared against an `Authorization`/`x-openclaw-webhook-secret` header.
  GitHub App webhook delivery never sends the secret itself — it HMAC-signs
  the raw body. Neither existing mechanism can verify a GitHub signature.
- `scripts/patch-wrapper-scoped-export.mjs` + `scripts/wrapper-state-export.mjs`
  is the established, working pattern for adding exactly one small
  wrapper-owned HTTP behavior via a build-time, anchored, guarded source
  patch — reused here rather than inventing a new mechanism (an OpenClaw
  plugin, which would mean publishing/installing an npm package and routing
  through the app/gateway process, is unnecessary for this narrow scope).

## Approach

One new module (`scripts/wrapper-github-webhook-verify.mjs`) implementing
the route handler as pure, directly-testable functions, patched into the
vendored wrapper's `src/server.js` by one new anchored patch script
(`scripts/patch-wrapper-github-webhook.mjs`), registered in `Dockerfile`
alongside the existing `wrapper-state-export.mjs` step. The route is
registered *before* `app.use(requireDashboardAuth, ...)` (the catch-all
proxy to the OpenClaw gateway), so a request to `/hooks/github-webhook-verify`
never reaches the gateway at all — pure wrapper-owned logic.

**Naming is deliberately generic, not tied to any one deployed instance.**
This patch lands in the *shared* wrapper image every provisioned instance
builds from. The route and its env var (`GITHUB_WEBHOOK_SECRET`) ship to
every instance automatically; each instance opts in independently later by
setting its own secret and registering its own App webhook URL — no code
change. When `GITHUB_WEBHOOK_SECRET` is unset (default), the route responds
`404` rather than accepting unsigned requests, so instances that haven't
opted in stay inert.

### Module contract (pins D1/D3's shared interface so both can be authored in parallel)

`scripts/wrapper-github-webhook-verify.mjs` exports:

```js
export function computeGithubSignature(secret: string, rawBody: Buffer): string
// Returns "sha256=" + hex HMAC-SHA256 digest of rawBody keyed by secret.

export function verifyGithubSignature(secret: string, rawBody: Buffer, headerValue: string | undefined): boolean
// false if secret or headerValue is falsy, or lengths differ, or timingSafeEqual fails.
// true only on an exact timing-safe match against computeGithubSignature's output.

export function readRawBody(req: IncomingMessage, opts?: { maxBytes?: number; timeoutMs?: number }): Promise<Buffer>
// Defaults: maxBytes 1 MiB, timeoutMs 10_000. Rejects on oversize, timeout, or stream error.

export async function handleGithubWebhookVerify(req, res, options?: { secret?: string; log?: (line: string) => void }): Promise<void>
// options.secret defaults to process.env.GITHUB_WEBHOOK_SECRET; options.log defaults to console.log.
// - No secret configured -> 404, body "Not Found".
// - Non-POST -> 405, Allow: POST.
// - Body read failure (oversize/timeout/stream error) -> 400.
// - Signature (X-Hub-Signature-256 header) does not verify -> 401, logs {route, result:"rejected"} only (no payload).
// - Signature verifies -> 200, body "ok", logs {route, result:"accepted", event, deliveryId, repo}
//   (event = X-Github-Event header, deliveryId = X-Github-Delivery header, repo = parsed body's
//   repository.full_name when the body parses as JSON, undefined otherwise — a parse failure here
//   does not change the response, only what gets logged).
```

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
|----|-------------|------|-------------|---------|
| D1 | `scripts/wrapper-github-webhook-verify.mjs` — the module contract above | module | `/devops` | 1 |
| D2 | `scripts/patch-wrapper-github-webhook.mjs` + `Dockerfile` (`COPY` both scripts, `RUN` the patch + `node --check` + `grep -qF` guards, comment block explaining the route/env var and the generic multi-instance-safe naming) — registers `POST /hooks/github-webhook-verify` immediately before `app.use(requireDashboardAuth, async (req, res) => {` in the vendored `src/server.js` | endpoint (build-time patch) | `/devops` | 1 |
| D3 | `tests/openclaw-railway-wrapper-patches.test.ts` (extend: add the `app.use(requireDashboardAuth, ...)` anchor line to `SYNTHETIC_SERVER_JS` if not already present, add a `patch-wrapper-github-webhook` describe block mirroring the existing apply-once/refuse-twice/composes-with-siblings/missing-anchor pattern) + new `tests/wrapper-github-webhook-verify.test.ts` (direct unit tests of D1's exported functions, including adversarial inputs the module contract implies: mutated-body signature, wrong-secret signature, empty body, unset secret, oversized body, non-POST) | test | `/test-engineer` | 1 |
| D4 | `docs/plans/github-webhook-verify/plan.md` — this plan | doc | `/project-manager` | 1 |
| D5 | `docs/plans/github-webhook-verify/ACs.md` | doc | `/project-manager` | 1 |
| D6 | `docs/plans/github-webhook-verify/review.md` — `/review` report | doc | `/project-manager` | 1 |
| D7 | Tracking issue [#108](https://github.com/yuens1002/openclaw-control-plane/issues/108) — already filed, referenced here for Gate 1 traceability of the "file the issue" step | doc | `/project-manager` | 1 |

### Files to Create

| File | Purpose |
|------|---------|
| `scripts/wrapper-github-webhook-verify.mjs` | D1 |
| `scripts/patch-wrapper-github-webhook.mjs` | D2 |
| `tests/wrapper-github-webhook-verify.test.ts` | D3 |
| `docs/plans/github-webhook-verify/ACs.md` | D5 |
| `docs/plans/github-webhook-verify/review.md` | D6 |

### Files to Edit

| File | Change |
|------|--------|
| `Dockerfile` | `COPY` D1+D2's scripts, `RUN` the patch + guards, comment block |
| `tests/openclaw-railway-wrapper-patches.test.ts` | Extend `SYNTHETIC_SERVER_JS` + add the new patch script's test block |

## Sessions

| Session | Scope (deliverable IDs) | ACs |
|---------|--------------------------|-----|
| Session 1 | D1, D2, D3, D4, D5, D6, D7 | `docs/plans/github-webhook-verify/ACs.md` |

## Acceptance Criteria

→ See `docs/plans/github-webhook-verify/ACs.md`.

- **Session 1**: Route exists, signature verification is correct (valid → 200,
  invalid/missing → 401, unset secret → 404), the patch script follows the
  established apply-once/refuse-twice contract, `node --check` passes,
  `npm run precheck` is green, and the tracking issue is filed.

## Commit Schedule

1. Plan commit: `docs: add plan for github-webhook-verify`
2. ACs commit: `docs: add ACs for github-webhook-verify`
3. Implementation: `feat: add signature-verified GitHub webhook route to wrapper`
4. Tests: `test: add coverage for github-webhook-verify handler and patch script`
5. Verification: `chore: update verification status`

## Dependencies

None internal. External: the private governance issue (owner-approval side)
must register the App webhook and provision the Railway secret before this
route does anything useful in production — out of scope for this repo's
work, tracked there.

## Out of Scope

- Any agent dispatch, session routing, or work-key dedup off a verified
  webhook.
- Registering the GitHub App webhook, provisioning the `GITHUB_WEBHOOK_SECRET`
  Railway variable, or the actual production deploy of this change — owned
  by the private governance issue's procedure.
- Enrolling any repository beyond whichever the App already has selected.
- `pull_request_review` / `pull_request_review_comment` support.
- An OpenClaw plugin or any change to the upstream gateway/app process.
