# Setup Profile Applier Acceptance Criteria

**Branch:** `feat/setup-profile-applier`
**Plan:** `docs/plans/setup-profile-applier/plan.md`

## Context

This applier closes the gap between the shell Railway install and a
configured OpenClaw instance by reading a generated client profile,
resolving secrets, and driving `/setup`'s JSON API. It must never log or
persist a secret value beyond the single call that needs it, must be safe
to re-run against an already-configured instance, and must never call the
real OpenRouter Provisioning API from a test or CI run. Session 1 (D1–D10)
covers every non-mutating path; Session 2 (D11–D21) adds minting, Railway
variable writes, and the mutating `/setup` calls.

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
| AC-COV-001 | D9 | `/project-manager` | Plan exists and names the schema-validation gate | Code review: `docs/plans/setup-profile-applier/plan.md` | Plan names branch, source, deliverables with session split, design decisions (idempotency, Railway CLI commands, ordering, error shapes, secret-safety), files to create/edit, sessions, and commit schedule; the Dependencies section explicitly names real-profile schema validation as a hard blocker before Session 1 Implement starts, not a follow-up | | | PENDING |
| AC-COV-002 | D10 | `/project-manager` | AC table exists with traceable workflow columns | Code review: `docs/plans/setup-profile-applier/ACs.md` | Every non-regression AC row has a valid Plan ref (D1–D21) and Role, plus Agent, QC, and Reviewer columns | | | PENDING |
| AC-COV-003 | D21 | `/project-manager` | Final review scaffold exists | Code review: `docs/plans/setup-profile-applier/review.md` | Review doc has sections for findings, verification, AC coverage, residual risk, and recommendation | | | PENDING |
| AC-COV-004 | D7 | `/devops` | New package is wired into the workspace | Code review: `tsconfig.json`, `tsconfig.base.json`, `tests/tsconfig.json`, `package.json` | `packages/openclaw-setup-applier` has a project reference, a path alias, a test-project reference, and a root CLI script | | | PENDING |
| AC-COV-005 | D18 | `/devops` | New env vars are documented | Code review: `.env.example` | Placeholder entries exist for every new env var (e.g. `OPENROUTER_MANAGEMENT_KEY`); no real key, token, or ID is present | | | PENDING |
| AC-COV-006 | D5 | `/test-engineer` | Fake/manual example profiles exist | Code review: `fixtures/setup-profile/` | At least one plain-secret provider profile, one `keyProvisioning` provider profile, and one channel profile exist, each using sentinel secret values and reserved example hostnames, following the `fixtures/vending` convention | | | PENDING |
| AC-COV-007 | D8 | `/project-manager` | Feature doc exists | Code review: `docs/setup-profile-applier.md` | Doc explains the profile shape consumed, required env vars, dry-run-first usage, and an explicit warning against calling `/setup/api/run` or `/setup/api/reset` outside this applier's tested path | | | PENDING |

## Functional Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-FN-001 | D1 | `/backend-architect` | Profile schema tolerance | Code review: `packages/openclaw-setup-applier/src/profile-schema.ts`; test run covers unknown-field and missing-field cases | Parsing a profile with an extra unrecognized field succeeds; parsing a profile missing a field the applier consumes fails with that field's path in the error, not a generic message | | | PENDING |
| AC-FN-002 | D2 | `/backend-architect` | Setup API read calls | Code review: `packages/openclaw-setup-applier/src/setup-api-client.ts` | `GET /setup/api/status` and `GET /setup/api/auth-groups` are implemented with an injectable `fetch`, and thrown errors carry only the HTTP status, never request/response bodies | | | PENDING |
| AC-FN-003 | D3 | `/devops` | Railway variable read path | Code review: `packages/openclaw-setup-applier/src/railway-variables.ts` | Resolving a named variable on the target service calls `railway variable list --service <service> --json` via the injectable `RailwayRunner` and returns the named value from the parsed JSON without printing it | | | PENDING |
| AC-FN-004 | D4 | `/backend-architect` | Dry-run mode | Code review: `packages/openclaw-setup-applier/src/apply-profile.ts` `--dry-run` path | Given a fixture profile, dry-run reports which required secrets are present vs. missing and prints the would-be `/setup/api/run` payload with every secret field redacted; no network call mutates any external state | | | PENDING |
| AC-FN-005 | D11 | `/backend-architect` | OpenRouter key minting | Code review: `packages/openclaw-setup-applier/src/openrouter-provisioning.ts` | Minting calls `POST /api/v1/keys` with the profile's `spendLimitUsd`/`limitReset` and the agency management key from env, and returns the minted key without printing it | | | PENDING |
| AC-FN-006 | D12 | `/devops` | Railway variable write path | Code review: `packages/openclaw-setup-applier/src/railway-variables.ts` write path | Setting a variable on the target service calls `railway variable set KEY=VALUE --service <service> --skip-deploys --json` via the injectable `RailwayRunner`, without printing the value; the `customProviderApiKeyEnv` path omits `--skip-deploys` per the plan's ordering decision | | | PENDING |
| AC-FN-007 | D13 | `/backend-architect` | Setup API mutating calls | Code review: `packages/openclaw-setup-applier/src/setup-api-client.ts` mutating path | `POST /setup/api/run` and `POST /setup/api/reset` are implemented with the same injectable-`fetch`, status-only-error convention as the read calls | | | PENDING |
| AC-FN-008a | D14 | `/backend-architect` | Idempotency — skip already-configured | Test run: `tests/openclaw-setup-applier-apply-profile.test.ts` "already configured" case | Given a stubbed `GET /setup/api/status` reporting configured, `apply-profile` never calls `POST /setup/api/run` | | | PENDING |
| AC-FN-008b | D14 | `/backend-architect` | Idempotency — skip already-minted | Test run: `tests/openclaw-setup-applier-apply-profile.test.ts` "secret already present" case | Given a `keyProvisioning` attachment whose declared secret name is already present in stubbed Railway variables, `apply-profile` never calls the OpenRouter mint endpoint for that attachment | | | PENDING |
| AC-FN-008c | D14 | `/backend-architect` | Ordering — restart-dependent path re-healthchecks | Code review: `packages/openclaw-setup-applier/src/apply-profile.ts` `customProviderApiKeyEnv` path | Writing a variable that feeds `customProviderApiKeyEnv` omits `--skip-deploys` and re-runs the `/setup/healthz` healthcheck before `POST /setup/api/run` is called for that path | | | PENDING |
| AC-FN-009 | D15 | `/devops` | CLI entrypoint | Code review: `packages/openclaw-setup-applier/src/cli.ts` | CLI exposes a `--dry-run` flag and an apply mode, following `packages/openclaw-railway-installer/src/cli.ts` argument-parsing conventions | | | PENDING |
| AC-FN-010 | D19 | `/project-manager` | Public positioning updated | Code review: `README.md`, `docs/architecture.md`, `docs/setup-profile-applier.md` | The "a clean place to define setup-profile conventions" line points at the applier concretely; `docs/architecture.md`'s package list includes `packages/openclaw-setup-applier`; none of the three docs names any specific private repo, agency, or client — the profile source is described generically as "a private agency/client profile repo," matching `docs/README.md`'s Public-Repo Rule | | | PENDING |

## Security Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-SEC-001 | D16 | `/security` | Secret values never appear in output | Test run: `tests/openclaw-setup-applier-apply-profile.test.ts` sentinel-capture cases — a `--dry-run` and a fully fetch-stubbed / `FakeRailwayRunner`-stubbed apply run, both against a fixture profile (D5) whose secret values are distinctive sentinels (e.g. `sk-test-DO-NOT-LOG-*`), with `console.log`/`console.error` spied | No sentinel value appears in any spied stdout or stderr call across either run | | | PENDING |
| AC-SEC-002 | D16 | `/security` | Applier writes no local files | Code review: `packages/openclaw-setup-applier/src/apply-profile.ts` and `cli.ts` | Neither module writes to the filesystem; the only outputs are the (redacted) stdout stream and the network calls each secret value serves, per the plan's secret-safety design decision | | | PENDING |
| AC-SEC-003 | D17 | `/security` | Tests never call the real OpenRouter API | Code review: `tests/openclaw-setup-applier-*.test.ts` covering D11 | Every test exercising `openrouter-provisioning.ts` stubs `fetch`; no test's assertions depend on a live network call to `openrouter.ai` | | | PENDING |

## Test Coverage Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-TST-001 | D6 | `/test-engineer` | Session 1 (non-mutating) test run | Test run: `npm.cmd run test -- --run tests/openclaw-setup-applier-profile-schema.test.ts tests/openclaw-setup-applier-setup-api-client.test.ts tests/openclaw-setup-applier-railway-variables.test.ts tests/openclaw-setup-applier-apply-profile.test.ts` | Schema-tolerance, read-client, and dry-run-redaction tests pass, 0 failures | | | PENDING |
| AC-TST-002 | D17 | `/test-engineer` | Session 2 (mutating) test run | Test run: `npm.cmd run test -- --run tests/openclaw-setup-applier-openrouter-provisioning.test.ts tests/openclaw-setup-applier-cli.test.ts tests/openclaw-setup-applier-setup-api-client.test.ts tests/openclaw-setup-applier-railway-variables.test.ts tests/openclaw-setup-applier-apply-profile.test.ts` | Minting, variable-write, mutating-client, and both idempotency-branch tests pass, 0 failures | | | PENDING |
| AC-TST-003 | D20 | `/test-engineer` | Full project verification | Test runs: `npm run typecheck`, `npm test`, `npm run build` | Typecheck, all tests, and build complete with 0 failures | | | PENDING |

## Regression Acceptance Criteria

| AC | Plan ref | Role | What | How | Pass | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| AC-REG-001 | — | `/test-engineer` | All existing tests pass | Test run: `npm test` | Full suite passes with the new test files included, 0 failures | | | PENDING |
| AC-REG-002 | — | `/devops` | Dependency audit stays clean | Test run: `npm audit --omit=dev` | 0 vulnerabilities reported, matching the existing `ci.yml` gate | | | PENDING |
