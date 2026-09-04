# GitHub webhook signature verification — Acceptance Criteria

**Branch:** `feat/github-webhook-verify`
**Plan:** `docs/plans/github-webhook-verify/plan.md`

---

## Context

Adds `POST /hooks/github-webhook-verify` to the Railway wrapper: verifies a
GitHub App webhook's `X-Hub-Signature-256` HMAC-SHA256 signature and
responds 200/401, with no dispatch or gateway involvement. Implements
[issue #108](https://github.com/yuens1002/openclaw-control-plane/issues/108).
No UI in this repo (backend/infra monorepo — `/ui-verify` does not apply).

---

## Column Definitions

| Column | Filled by | When |
|--------|-----------|------|
| **Plan ref** | Author of the ACs | At AC authoring — links each row to a Plan deliverable ID |
| **Role** | Author of the ACs | At AC authoring — names the role that owns this AC's verification |
| **Agent** | Verification sub-agent (orca Verify stage) | During Verify — PASS/FAIL with brief evidence |
| **QC** | Main thread agent | After reading sub-agent report — confirms or overrides |
| **Reviewer** | Human (operating owner) | During manual review — final approval per AC |

---

## Pass-condition rule

Pass = invariant, not config-literal. Every row below states a relation
(signature computed against the actual secret and body, not a hardcoded
digest string) — see `~/.claude/templates/acs-template.md`.

---

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-FN-1 | D1 | `/devops` | `computeGithubSignature` / `verifyGithubSignature` — signature guard | Code review: `scripts/wrapper-github-webhook-verify.mjs` → trace `createHmac`/`timingSafeEqual` usage | `verifyGithubSignature` returns `true` only when the header equals `computeGithubSignature(secret, rawBody)` exactly (timing-safe compare, no early-return on length before comparing); returns `false` on any mismatch, missing header, or missing secret | | | |
| AC-FN-2 | D2 | `/devops` | `POST /hooks/github-webhook-verify` — route placement | Code review: `scripts/patch-wrapper-github-webhook.mjs` → confirm the injected `app.post(...)` block appears before `app.use(requireDashboardAuth, ...)` in patched `src/server.js` | The route responds without ever reaching `proxy.web(...)` — a request to it cannot reach the OpenClaw gateway | | | |
| AC-FN-3 | D2 | `/devops` | Route — unset-secret behavior | Code review: `scripts/wrapper-github-webhook-verify.mjs` `handleGithubWebhookVerify` | When `GITHUB_WEBHOOK_SECRET` is unset, the handler responds 404 before reading the body or comparing any signature | | | |
| AC-FN-4 | D2 | `/devops` | Patch script — idempotency guard | Code review: `scripts/patch-wrapper-github-webhook.mjs` | Anchor matched by exact literal block via `String.prototype.replace`, guarded to exactly one occurrence; a second run refuses (non-zero exit, clear stderr) and leaves the file untouched — same contract as `patch-wrapper-scoped-export.mjs` | | | |
| AC-FN-5 | D2 | `/devops` | `Dockerfile` wiring | Code review: `Dockerfile` | `COPY` of both new scripts, `RUN node patch-wrapper-github-webhook.mjs src/server.js`, `grep -qF` assertions for the injected route + import, and `node --check src/server.js`, in that order, following the exact structure of the existing `wrapper-state-export.mjs` step | | | |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-TST-1 | D3 | `/test-engineer` | `verifyGithubSignature` — valid signature | Test run: `npm test` (`tests/wrapper-github-webhook-verify.test.ts`) | A signature computed by `computeGithubSignature(secret, body)` verifies `true` against that exact `(secret, body)` pair | | | |
| AC-TST-2 | D3 | `/test-engineer` | `verifyGithubSignature` — adversarial mismatches | Test run: `npm test` | Each of: one-byte-mutated body, wrong secret, missing header, empty-string header, and a header of different length than expected — all verify `false`. These are inputs the verifier constructs directly (not copied from a fixture), per the module contract's stated adversarial set | | | |
| AC-TST-3 | D3 | `/test-engineer` | `handleGithubWebhookVerify` — full response matrix | Test run: `npm test` (mock `req`/`res`) | Valid signature → 200; invalid/missing signature → 401 and the mock `log` receives no `body`/`payload` field; unset `options.secret` → 404; non-POST method → 405 with `Allow: POST`; body exceeding `maxBytes` → the promise rejects and the handler responds 400 | | | |
| AC-TST-4 | D2 | `/test-engineer` | `patch-wrapper-github-webhook` — applies once, refuses twice | Test run: `npm test` (`tests/openclaw-railway-wrapper-patches.test.ts`, new describe block) | First run: exit 0, `node --check` passes on the patched fixture, exactly one occurrence of the injected route registration. Second run on the same fixture: non-zero exit, stderr matches an occurrence-count message, fixture file unchanged from the first run's output | | | |
| AC-TST-5 | D2 | `/test-engineer` | `patch-wrapper-github-webhook` — composes with existing patches | Test run: `npm test` | Running `patch-wrapper-restart-gateway`, `patch-wrapper-scoped-export`, and `patch-wrapper-github-webhook` in the Dockerfile's order against one fixture leaves all three patches' invariants intact (existing assertions for the first two unchanged) and the composed file still passes `node --check` | | | |
| AC-TST-6 | D2 | `/test-engineer` | `patch-wrapper-github-webhook` — missing anchor | Test run: `npm test` | Running the patch script against a fixture with the `app.use(requireDashboardAuth, ...)` anchor removed exits non-zero with an occurrence-count-0 message; the fixture file is left untouched | | | |

## Coverage / Documentation Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-COV-1 | D4 | `/project-manager` | Plan exists | Code review: `docs/plans/github-webhook-verify/plan.md` | Plan names the issue, branch, current state, approach, module contract, deliverables with roles, sessions, commit schedule, dependencies, out of scope | | | |
| AC-COV-2 | D5 | `/project-manager` | ACs table exists and covers the plan | Code review: this file | Every AC row has a valid Plan ref (D1–D7, or `—` for regression rows) and a Role; every deliverable D1–D7 is referenced by at least one row; Gate 1 (`npm run check:acs-coverage`) passes | | | |
| AC-COV-3 | D6 | `/project-manager` | Review scaffold exists after Phase 4.5 | Code review: `docs/plans/github-webhook-verify/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, hygiene, recommendations | | | |
| AC-DOC-1 | D2 | `/devops` | Doc/comment hygiene in code changes | Code review: diff of `Dockerfile` and any README/`docs/live-instance-operations.md` edit | No production Railway project/service ID, hostname, or tenant-identifying detail in any new comment or doc line — only the generic route name, env var name, and the technical rationale | | | |
| AC-DOC-2 | D7 | `/project-manager` | Tracking issue hygiene — fetch the live artifact, not the draft | Fetch the actual posted issue via `gh issue view 108 --repo yuens1002/openclaw-control-plane --json body,title` (the live artifact, not this plan's draft) and grep its body/title for: the string `openclaw-cot-agency-profile`, the string `dev-yuen-agency`, `#41`, any Railway service/project id, any hostname | Zero matches for every forbidden term above in the live issue's actual title+body | | | |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
|----|----------|------|------|-----|------|-------|----|----------|
| AC-REG-1 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | 287+ tests pass, 0 failures (baseline was 287 on `main` @ `f50e8761e71040f919f45a9b8b5bf72f65dc2232`) | | | |
| AC-REG-2 | — | `/devops` | Precheck passes clean | Test run: `npm run precheck` | 0 type errors, build succeeds, precheck stamp written for the branch's HEAD | | | |

---

## Agent Notes

*Sub-agent writes here during Verify.*

## QC Notes

*Main thread writes here during Phase 4.*

## Reviewer Feedback

*Human fills this section during review.*
