# GitHub Webhook Agent Dispatch — Plan

Branch: `feat/github-webhook-agent-dispatch`
Source: [issue #116](https://github.com/yuens1002/openclaw-control-plane/issues/116) (multi-secret verify) and [issue #117](https://github.com/yuens1002/openclaw-control-plane/issues/117) (dispatch to `/hooks/agent`), cross-referenced from a private governance issue that owns repository enrollment policy, credential provisioning, and live-verification sign-off.

## Summary

Extend the wrapper's verified GitHub webhook route (`POST /hooks/github-webhook-verify`, #108) so that it (a) verifies a delivery's signature against any of several independently configured secrets, and (b) forwards accepted, allowlisted deliveries to OpenClaw's native `POST /hooks/agent` endpoint — under a session key stable per PR/issue, distinct from the dedup key used to decide whether to forward at all — instead of only logging. This closes the dispatch gap #108 deliberately left out of scope.

## Current State

- `scripts/wrapper-github-webhook-verify.mjs`'s `handleGithubWebhookVerify` reads exactly one secret (`options.secret ?? process.env.GITHUB_WEBHOOK_SECRET`), verifies it, logs `{route, result, event, deliveryId, repo}` on success, and returns. No forwarding of any kind happens today.
- A deployment may have more than one GitHub App delivering to this route (each App signs with its own webhook secret) — today only one secret is checked, so a second App's deliveries would be rejected.
- OpenClaw's `POST /hooks/agent` is a native gateway endpoint (`hooks.enabled`/`hooks.token`/`hooks.path` in `openclaw.json`) that runs an agent turn under a caller-scoped session key. It runs in the same OpenClaw gateway process this wrapper route is deliberately registered *ahead of* (see #108's plan — the route never reaches the gateway). Reaching `/hooks/agent` from this route therefore means an explicit HTTP call from the wrapper process to the gateway process, not an in-process function call. **The exact local address/port and how the wrapper already knows it (if it does) is not yet confirmed — the first concrete step of D3 is inspecting the pinned wrapper's `src/server.js` for its own existing gateway-proxy target, the same empirical method #108 used to find the body-parser ordering issue, rather than assuming a value.**

## Approach

Three focused module extensions to `scripts/wrapper-github-webhook-verify.mjs`, each independently testable, wired together in `handleGithubWebhookVerify`:

1. Multi-secret verification (#116).
2. Dedup-key and session-key computation, plus a generic allowlist consult (#117).
3. Forwarding to `/hooks/agent` (#117).

No new wrapper route, no OpenClaw plugin, no change to the upstream gateway/app process — same minimal-footprint approach #108 established.

### Module contract additions

```js
export function verifyAnyGithubSignature(secrets: string[], rawBody: Buffer, headerValue: string | undefined): boolean
// True if headerValue verifies against ANY secret in `secrets` (each compared
// via the existing timing-safe verifyGithubSignature). False if `secrets` is
// empty. Does not reveal which secret (or how many) matched.

export function resolveGithubWebhookSecrets(env = process.env): string[]
// Reads GITHUB_WEBHOOK_SECRETS (a JSON array string) if set and non-empty;
// otherwise falls back to a single-element array from GITHUB_WEBHOOK_SECRET
// if that is set; otherwise []. A malformed GITHUB_WEBHOOK_SECRETS (not valid
// JSON, or not an array of non-empty strings) throws a tagged config error,
// mirroring resolveGithubWebhookMaxBytes's own fail-loud-on-misconfig pattern
// -- never silently falls back to treating it as a single literal secret.

export function computeDedupKey(event: string, payload: object): string | undefined
// repo + resource number + observed head for pull_request (owner/repo#N@sha);
// repo + resource number + comment id for issue_comment (owner/repo#N/comment-id).
// Returns undefined if the payload lacks the fields the event type requires
// (malformed body) -- caller must not forward when this is undefined.

export function computeSessionKey(event: string, payload: object): string | undefined
// repo + resource number ONLY (owner/repo#N) -- stable across every delivery
// on the same PR/issue regardless of event type, head, or comment id. This is
// deliberately NOT the dedup key -- see #117's "Why" section for the bug an
// earlier draft had here (a session key that varied with head/comment id gave
// the dispatched agent a fresh, unrelated session on every delivery).
// Returns undefined under the same malformed-payload condition as the dedup key.

export function resolveDispatchAllowlist(env = process.env): DispatchAllowlistEntry[]
// Reads GITHUB_DISPATCH_ALLOWLIST (a JSON array string): each entry names a
// repo, its permitted { event, actions[] } combinations, and (only where
// issue_comment is permitted) a trustedMention condition (actor allowlist +
// mention pattern). Empty/unset -> []. Malformed JSON or a shape violation
// throws a tagged config error (fail loud, not fail open) -- an allowlist
// that can't be parsed must not be treated as "allow nothing" silently
// mistaken for "allow everything," and must not crash requests either, so
// the CALLER treats a thrown resolve as "do not forward, log a config-error
// line" rather than propagating a 500 to GitHub for what is a deploy-config
// problem, not this delivery's fault.
// No repository, actor, or workflow name is hardcoded anywhere in this repo
// -- every value here is deployment-owner configuration.

export function matchesDispatchAllowlist(entries: DispatchAllowlistEntry[], event: string, action: string | undefined, repoFullName: string | undefined, actorLogin: string | undefined, commentBody: string | undefined): boolean
// True only if repoFullName has an entry permitting this (event, action) pair,
// AND, for issue_comment specifically, actorLogin is in that entry's
// trustedMention.actors AND commentBody matches trustedMention.pattern.
// commentBody is used ONLY for this boolean pattern match -- it is never
// returned, logged, or included in anything this function's caller forwards.

export async function forwardToAgentHook(sessionKey: string, event: string, payload: object, options?: { hookUrl?: string, hookToken?: string, fetchImpl?: typeof fetch }): Promise<{ forwarded: boolean }>
// POSTs { sessionKey, trigger: { event, repo, resource, actor, deliveryId } }
// (explicitly NOT the raw comment/PR body -- only these labeled, non-executable
// metadata fields) to options.hookUrl (default resolved per the Current State
// note above) with options.hookToken as a bearer/hook-token header. Never
// throws on the downstream call failing -- logs and returns { forwarded: false }
// so a hook-endpoint outage degrades to "verified but not dispatched," never
// a 5xx back to GitHub for something GitHub didn't cause.
```

`handleGithubWebhookVerify` changes only in its post-verification branch: after logging the existing accepted-delivery line, it now also computes the dedup key, checks a small in-memory (or otherwise locally decided — implementer's call, documented in D2) set for "already forwarded," consults the allowlist, and on a new, matching delivery calls `forwardToAgentHook` with the session key. The HTTP response to GitHub (200/401/404/405/400) is **unchanged** by any of this — dispatch outcome is logged, never reflected in the status code.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role | Session |
|----|-------------|------|-------------|---------|
| D1 | `verifyAnyGithubSignature` + `resolveGithubWebhookSecrets` in `scripts/wrapper-github-webhook-verify.mjs`; `handleGithubWebhookVerify` reads secrets via the new resolver | module extension | `/devops` | 1 |
| D2 | `computeDedupKey`, `computeSessionKey`, `resolveDispatchAllowlist`, `matchesDispatchAllowlist` in the same module | module extension | `/devops` | 1 |
| D3 | `forwardToAgentHook` + wiring it into `handleGithubWebhookVerify`'s post-verification branch (dedup check, allowlist check, forward on match) — includes the empirical investigation of the local `/hooks/agent` address noted in Current State | module extension + integration | `/devops` | 1 |
| D4 | `tests/wrapper-github-webhook-verify.test.ts` — extend with direct unit tests of every D1–D3 export, including a pre-drained-stream-shaped adversarial case for the integration point per this ecosystem's own retro rule (a fixture built fresh-only misses "already wired into the pipeline" bugs) | test | `/test-engineer` | 1 |
| D5 | `docs/plans/github-webhook-agent-dispatch/plan.md` — this plan | doc | `/project-manager` | 1 |
| D6 | `docs/plans/github-webhook-agent-dispatch/ACs.md` | doc | `/project-manager` | 1 |
| D7 | README / `docs/live-instance-operations.md` update documenting `GITHUB_WEBHOOK_SECRETS`, `GITHUB_DISPATCH_ALLOWLIST`, and the dispatch behavior generically (no example ever names a real repo/actor) | doc | `/project-manager` | 1 |

### Files to Create

| File | Purpose |
|------|---------|
| `docs/plans/github-webhook-agent-dispatch/ACs.md` | D6 |

### Files to Edit

| File | Change |
|------|--------|
| `scripts/wrapper-github-webhook-verify.mjs` | D1, D2, D3 |
| `tests/wrapper-github-webhook-verify.test.ts` | D4 |
| `README.md` or `docs/live-instance-operations.md` | D7 |
| `CHANGELOG.md` | Entry for the release version |

## Sessions

| Session | Scope (deliverable IDs) | ACs |
|---------|--------------------------|-----|
| Session 1 | D1, D2, D3, D4, D5, D6, D7 | `docs/plans/github-webhook-agent-dispatch/ACs.md` |

## Acceptance Criteria

→ See `docs/plans/github-webhook-agent-dispatch/ACs.md`.

- **Session 1**: multi-secret verification is correct and backward compatible; dedup key and session key are computed correctly and are provably different keys for the same delivery; the allowlist consult fails closed on any unmatched/malformed input; forwarding never changes the HTTP response contract to GitHub; `precheck` is green; the tracking issues (#116, #117) reflect the shipped design.

## Commit Schedule

1. Plan commit: `docs: add plan for github-webhook-agent-dispatch`
2. ACs commit: `docs: add ACs for github-webhook-agent-dispatch`
3. Implementation: `feat: verify against multiple webhook secrets` (D1)
4. Implementation: `feat: compute dedup/session keys and consult dispatch allowlist` (D2)
5. Implementation: `feat: forward allowlisted webhook deliveries to /hooks/agent` (D3)
6. Tests: `test: cover multi-secret verify, key computation, allowlist, and dispatch forwarding` (D4)
7. Docs: `docs: document GITHUB_WEBHOOK_SECRETS and GITHUB_DISPATCH_ALLOWLIST` (D7)
8. Verification: `chore: update verification status`

## Dependencies

None internal. External, owned by the private governance issue: configuring `GITHUB_WEBHOOK_SECRETS` and `GITHUB_DISPATCH_ALLOWLIST` as real Railway values, registering the second GitHub App's webhook, provisioning its secret, and confirming `/hooks/agent` supports resuming a session by caller-supplied key on the target deployment (a blocking prerequisite for D3 to be useful in production — see #117's Out of Scope) — none of this is testable or buildable from within this repo.

## Out of Scope

- Registering any GitHub App's webhook, provisioning secrets, or defining the allowlist's actual values — deployment-owner procedure, tracked privately.
- The downstream agent turn's own behavior (re-fetching PR state, verifying head freshness, deciding to act, posting anything) — owned by the dispatched agent's own workflow and authority policy, tracked privately.
- `pull_request_review` / `pull_request_review_comment` support.
- Any change to OpenClaw's own `/hooks/agent` implementation.
- Any Decision Runtime call from this route — forwarding to `/hooks/agent` is the entire extent of this repo's involvement in what happens next.
