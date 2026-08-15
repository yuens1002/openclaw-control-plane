# Setup API Basic Auth Acceptance Criteria

**Branch:** `feat/setup-api-basic-auth`
**Plan:** `docs/plans/setup-api-basic-auth/plan.md`

## Context

`setup-api-client.ts` sends no auth header on any `/setup/api/*` call, so
`applyProfile()`'s mutating path fails against any `SETUP_PASSWORD`-protected
OpenClaw instance — the normal/recommended setup. This fix adds optional
Basic auth to the client and wires the target instance's credentials
(`OPENCLAW_INSTANCE_SETUP_PASSWORD`/`OPENCLAW_INSTANCE_SETUP_USERNAME` —
deliberately distinct from this repo's own `SETUP_PASSWORD`/
`OPENCLAW_SETUP_USERNAME`, see plan.md) through the CLI. Single session,
D1-D9.

## Column Definitions

| Column | Filled by | When |
| --- | --- | --- |
| Plan ref | Author | At AC authoring; links each row to a plan deliverable ID. |
| Role | Author | At AC authoring; names the role that owns verification. |
| Agent | Verification sub-agent | During AC verification; PASS/FAIL with evidence. |
| QC | Main thread agent | After reading verification evidence; confirms or overrides. |
| Reviewer | Human reviewer | During manual review; final sign-off per AC. |

## Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-COV-001 | D7 | `/project-manager` | Plan exists | Code review: `docs/plans/setup-api-basic-auth/plan.md` | Plan names branch, source, deliverables with roles, approach/design decisions (including the env-var-collision rationale), files to create/edit, gate 1/2 pre-check, commit schedule, dependencies, out of scope | | | PENDING |
| AC-COV-002 | D8 | `/project-manager` | ACs table exists | Code review: `docs/plans/setup-api-basic-auth/ACs.md` | Every AC row has a valid Plan ref (D1-D9) and Role, plus Agent/QC/Reviewer columns | | | PENDING |
| AC-COV-003 | D9 | `/project-manager` | Review scaffold exists | Code review: `docs/plans/setup-api-basic-auth/review.md` | Review doc has sections for verdict, deliverables↔code, ACs↔tests, docs drift, recommendations | | | PENDING |
| AC-COV-004 | D5 | `/backend-architect` | Feature doc updated | Code review: `docs/setup-profile-applier.md` | "Required env vars" table includes `OPENCLAW_INSTANCE_SETUP_USERNAME`/`OPENCLAW_INSTANCE_SETUP_PASSWORD`, scoped explicitly to the apply path (not dry-run), with a note on why these are distinct from this repo's own `SETUP_PASSWORD`/`OPENCLAW_SETUP_USERNAME` | | | PENDING |
| AC-COV-005 | D6 | `/backend-architect` | `.env.example` updated | Code review: `.env.example` | Commented `OPENCLAW_INSTANCE_SETUP_PASSWORD`/`OPENCLAW_INSTANCE_SETUP_USERNAME` entries present alongside the existing `SETUP_PASSWORD`/`OPENCLAW_SETUP_USERNAME` ones, with a comment distinguishing the two pairs; no real value | | | PENDING |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/backend-architect` | Basic auth header added when `auth` is given | Test run: `tests/openclaw-setup-applier-setup-api-client.test.ts` | Given `auth: {username, password}`, every one of the four calls (`getStatus`, `getAuthGroups`, `run`, `reset`) carries `Authorization: Basic <base64("username:password")>`, computed with standard base64 (verifiable by decoding the header value back to `username:password` in the test, not by pinning a literal encoded string) | | | PENDING |
| AC-FN-002 | D1 | `/backend-architect` | No auth header when `auth` is omitted (regression) | Test run: same file | With no `auth` option, none of the four calls carries an `Authorization` header — matches every existing (pre-fix) test in this file unchanged | | | PENDING |
| AC-FN-003 | D2 | `/backend-architect` | `requireEnv` helper | Test run: `tests/openclaw-setup-applier-cli.test.ts` | `requireEnv(name)` returns the env var's value when set; throws `Missing required env var: <name>` when unset, for an arbitrary var name (not hardcoded to one of the two real call sites, so the test proves the helper's general behavior) | | | PENDING |
| AC-FN-004 | D2 | `/backend-architect` | Auth wired into the apply path only | Code review: `cli.ts` `main()` | `OPENCLAW_INSTANCE_SETUP_PASSWORD`/`OPENCLAW_INSTANCE_SETUP_USERNAME` are read (via `requireEnv`/a default) and passed as `auth` to `createSetupApiClient` strictly after the `--dry-run` early return; the dry-run branch never reads or requires either var | | | PENDING |
| AC-FN-005 | D2 | `/backend-architect` | `OPENROUTER_MANAGEMENT_KEY` behavior preserved after refactor | Code review: `cli.ts` | The existing failure message (`Missing required env var: OPENROUTER_MANAGEMENT_KEY`) and timing (thrown before any network call, after the dry-run branch) are unchanged now that the check is routed through `requireEnv` | | | PENDING |

## Security Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SEC-001 | D1 | `/security` | Password never appears in thrown errors | Test run: `tests/openclaw-setup-applier-setup-api-client.test.ts` — authenticated request returning a non-2xx status | `SetupApiError`'s message contains neither the raw password nor the base64-encoded credential — matches the existing status-only error convention (`SetupApiError` already carries no response body; this AC confirms the *request*-side credential doesn't leak either) | | | PENDING |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D3, D4 | `/test-engineer` | New/extended test files pass | Test run: `npm test -- --run tests/openclaw-setup-applier-setup-api-client.test.ts tests/openclaw-setup-applier-cli.test.ts` | Both files pass, 0 failures, including every new auth-header and `requireEnv` case | | | PENDING |
| AC-TST-002 | — | `/test-engineer` | Full project verification | Test runs: `npm run typecheck`, `npm test`, `npm run build` | All three complete with 0 failures | | | PENDING |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new/extended test files included, 0 failures | | | PENDING |
| AC-REG-002 | — | `/devops` | Dependency audit stays clean | Test run: `npm audit --omit=dev` | 0 vulnerabilities; no new dependency added (base64 encoding uses Node's built-in `Buffer`) | | | PENDING |
