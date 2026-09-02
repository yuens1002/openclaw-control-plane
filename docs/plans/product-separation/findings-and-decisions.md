# Product Separation — Findings, Decisions, and Target End State

Status: **decision record**. Supersedes the premises of
`docs/plans/runtime-release-versioning/plan.md` (draft, PR #94), which was
written before the product boundary was understood.

This document exists so the implementation plan that follows has nothing left
to re-derive. Part 1 is what is true today, verified against the code. Part 2
is what was decided and why. Part 3 is the target end state for infrastructure,
repository architecture, and update paths.

Every finding in Part 1 was checked against the repository. Where a claim was
made during analysis and later disproved, the correction is recorded rather
than the original.

---

## Part 1 — Verified Findings

### 1.1 The repository contains three products with zero code coupling

Dependency graph, verified in both directions:

```text
Decision Runtime (apps/api, apps/worker, apps/mcp)
  apps/api    → contracts, db, runtime-auth
  apps/worker → db, runtime-auth
  apps/mcp    → decision-runtime-mcp, mcp-service

  db                   → contracts
  runtime-auth         → contracts
  decision-runtime-mcp → contracts, mcp-service, openclaw-adapter
  openclaw-adapter     → contracts

Vending / provisioning
  openclaw-railway-installer → (no workspace deps)
  openclaw-setup-applier     → openclaw-railway-installer

Wrapper image
  root Dockerfile + scripts/*.mjs + railway.toml
```

- `openclaw-railway-installer` declares **no workspace dependencies at all**.
- Nothing under `apps/**` or the nine runtime packages imports the installer or
  the setup-applier.
- The root `Dockerfile` — the image client instances actually run — builds **no
  workspace package**. It assembles the upstream template, builds upstream
  OpenClaw, and copies three `scripts/*.mjs` patch files.

The only things coupling the three products are a shared `package.json`
version, a shared `package-lock.json`, one CI pipeline, one CHANGELOG, and one
release cadence. **All coupling is organisational, none is technical.**

### 1.2 The Decision Runtime is one deployable unit, including the worker

`apps/worker/src/index.ts` and `apps/api/src/server.ts` both call
`initializePostgresRuntime`, which runs `runSqlMigrations`
(`packages/db/src/runtime-bootstrap.ts`). Both processes auto-migrate the
shared database at startup, before listening. A worker at one version migrates
the database out from under an API at another.

API + worker + MCP + `contracts` + `db` cannot be versioned separately. This is
a code fact, not a design preference.

### 1.3 The policy layer lives in the private policy repo, and the engine is the substrate

Three layers, only two of which are in this repository:

| Layer | Where | What it holds |
| --- | --- | --- |
| Policy in prose | private policy repo | the reasoning loop, the decision-record shape, the authority axes |
| State contract | private policy repo | the mapping from prose concepts to typed runtime primitives |
| Runtime substrate | this repository | enforcement and recording against whatever registry it is given |

This explains a property that was otherwise inexplicable: the runtime seeds
only retired `legacy.*` registrations and keeps vocabulary as per-instance data
in `type_registrations` / `operation_registrations`. That is deliberate. The
vocabulary **is** a company's operating model, which is per-company by
definition. The engine ships empty; the policy repo fills it.

### 1.4 The attribution contract is faithfully implemented

`ActionAttributionSchema` (`packages/contracts/src/runtime.ts:266`) implements
the private state contract's `action_attempt` shape, field-for-field:
`correlation_id`, `request_id`, `tool_invocation_id` (optional),
`causation_ref`, `command_digest`, `canonicalization_version` as a
`z.literal("jcs-rfc8785-v1")`, `input_refs`, `outcome`.

`TrustedCommandContextSchema` carries `authenticated_principal_ref`,
`effective_actor`, `on_behalf_of_principal_ref`, `request_origin`, and
`authorization`. `AuthorizationEvidenceSchema` carries `decision_id`, `action`,
`result: allowed | denied`, **`policy_version`**, and `reason_codes`.
`AuthorizationDenialAuditPayloadSchema` records refusals with `request_id`,
`tool_invocation_id` (optional), `decision_id`, `policy_version`, and
`reason_codes` — not the full `AuthorizationEvidenceSchema` shape. Causation
is additionally modelled relationally — `record_edges.relation` is one of
`caused_by`, `derived_from`, `attempted_by`, `produced`, `approved_by`,
`supersedes`.

**Correction on the record:** an earlier pass reported that the schema had no
correlation field and modelled no link to agent telemetry. That was wrong — it
grepped `packages/db/src/schema.ts` for snake_case column names, when the
attribution lives in the typed contracts and persists inside the
`command_context` jsonb and record payloads.

Consequence: the product claim — *the stated policy mirrored onto a runtime
that records how the decision was made* — is substantially built. "Did the
agent do what the policy said" is a query over recorded `policy_version`,
`result`, and `reason_codes`, correlated to the originating tool call.
Observability is a by-product of the same record.

### 1.5 The engine is not yet vocabulary-free — one leak

`packages/contracts/src/control-plane.ts:44` defines `ArtifactKindSchema` as a
**closed enum**: `briefing`, `lead_snapshot`, `call_transcript`,
`call_summary`, `follow_up_draft`, `audit_note`. These are agency-specific
terms compiled into the engine's contracts.

Severity is modest while the engine has one operator and one policy — adding a
kind is an edit and a redeploy. It matters as a latent constraint on
modularity: a second policy, or an instance whose artifact kinds differ, needs
an engine change rather than a registration.

### 1.6 The runtime-to-instance integration is wired entirely by hand

`DECISION_RUNTIME_*` appears nowhere in code or provisioning scripts — not in
TypeScript, not in the PowerShell provisioning scripts — and nowhere in
documentation outside `docs/plans`. Nine such variables are nonetheless set on
the live instance, including a private signing key.

The one existing integration was configured out of band. Nothing provisions,
documents, or tests it.

### 1.7 A profile cannot express an MCP server

`packages/openclaw-setup-applier/src/profile-schema.ts` defines
`attachments: { modelProviders, channels }`. There is no MCP attachment type.
This is the concrete gap between today and "the profile declares the runtime
like any other MCP server."

### 1.8 Platform and tooling constraints

- **Railway tracks branches, not tags.** Disabling autodeploy only defers
  *when* the branch head deploys; a git-connected service cannot hold an older
  tag while its branch advances. Pinning therefore requires either a
  per-instance ref or a registry image tag.
- **`railway up` cannot express a pinned release.** It deploys one service from
  local disk with no recorded source revision.
  `docs/live-instance-operations.md` §2.2 isolates it as the `deploy` tier,
  §2.5 forbids it ad hoc, §6.1 records an incident. Its legitimate use is
  `provisionClientInstance`'s one-shot bootstrap of a service with no live
  state.
- **`npm version` is unusable here.** It rewrites `package-lock.json`, which is
  watched, reintroducing the per-release redeploy removed by issue #86 and
  guarded by `tests/decision-runtime-watch-patterns.test.ts`.
- **The root `railway.toml` *is* applied on snapshot deploys** — proven by
  deployment logs showing `Path: /setup/healthz`, a 5m0s retry window, and
  multi-stage Dockerfile build vertices. The single documented exception is the
  `[variables]` block, which `railway up` does not apply (recorded in
  `deploy/openclaw-railway/README.md`).

### 1.9 Verification and signal gaps

- **CI never runs `verify:decision-runtime`.** `.github/workflows/ci.yml` runs
  `npm test`, `npm run build`, and `npm audit`, but not
  `verify:decision-runtime` — the strongest verification in the repository is
  a local convention that can be skipped.
- **`verify:decision-runtime` covers the API image only.** It builds
  `deploy/decision-runtime/Dockerfile`; the worker and MCP images are never
  container-verified. It also tests a fresh install and never an upgrade.
- **Reported version is stale by construction.** `apps/mcp/src/index.ts`
  surfaces `CONTROL_PLANE_VERSION` from the root `package.json` baked at build
  time, but version-bump commits deliberately no longer trigger redeploys
  (issues #86, #89). The API reports no version at all.
- **`Railway Proof Verify` runs against unconfigured secrets.**
  `.github/workflows/railway-proof-verify.yml` runs weekly
  (`cron: "41 15 * * 1"`) or on manual dispatch, and depends on
  `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`, `RAILWAY_SERVICE_ID`,
  `RAILWAY_TOKEN` secrets and a `RAILWAY_PROOF_URL` var, none of which are set
  on this repository. Its three most recent scheduled runs (2026-08-17,
  2026-08-24, 2026-08-31) all failed. It watches nothing and provides no
  coverage.

### 1.10 Rollback does not behave as a naive reading suggests

- `validateHistoricalRecord` (`packages/db/src/runtime-repository.ts:682`,
  `:774`) validates historical records against the **in-memory** registry, so
  code rolled back below a release that introduced a record type **throws** on
  reads touching those streams. It does not ignore what it does not recognise.
- `synchronizeRegistry` issues an unconditional status update with
  `retired_at = CASE WHEN $4 = 'retired' THEN COALESCE(retired_at, now()) ELSE NULL END`,
  so a rollback **un-retires** registrations that the newer release retired.
- Migrations are forward-only with no down migrations, so a rollback always
  leaves the schema ahead of the code.

Rollback safety therefore depends on expand-contract discipline **plus** an
additive-only rule for registrations — not on the schema alone.

---

## Part 2 — Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D-1 | **Separate the three products into separate repositories.** | Zero code coupling (1.1) makes it a move, not a refactor. It removes the shared version and lockfile that generated every watch-pattern issue this session. |
| D-2 | **The Decision Runtime is one product and one version: API + worker + MCP + contracts + db.** | Structural, per 1.2. Not a preference. |
| D-3 | **The engine is consumed as an MCP server**, declared as a profile attachment like any other. | The instance already understands MCP. Replaces nine hand-set variables and manual custody of a signing key with a declarative, testable attachment. |
| D-4 | **`/v1/runtime` and `openclaw-adapter` become internal to the engine.** | Clients depend on the MCP tool contract, not the HTTP contract. Collapses the compatibility surface to where MCP already expects versioning. |
| D-5 | **The engine stays vocabulary-free; policy lives in the policy repo.** | 1.3. This is what makes it a substrate rather than bespoke tooling. `ArtifactKindSchema` (1.5) is the outstanding violation. |
| D-6 | **Modular, not bundled — but default-on.** The agency template declares the attachment by default and ships the operating model registered against it. | The engine is a general capability; the *operating model* is the opinion. Differentiation lives in the policy, so modularity costs nothing. Default-on-removable is reversible in both directions. |
| D-7 | **Repositories stay private for now; documentation is written to public standard.** Open-source when there is something worth sharing. | No audience today, so distribution cost is unrewarded. Writing to public standard is already habit and keeps the option open at no ongoing cost. |
| D-8 | **No deployed dev tier. The pre-merge loop is local.** | The bug classes this repository actually hits are fresh-provisioning ordering and live-traffic behaviour; a standing dev instance catches neither. |
| D-9 | **The agency instance is the canary**, tracking a release branch continuously. | It is the first place the one-runtime-per-instance topology is exercised, and the only place with real traffic. |
| D-10 | **Release cadence is a policy dial, not an architecture.** Build the machinery at every-merge; turn it down when a client exists. | A configuration change later, not a re-plumb. |
| D-11 | **The client pin mechanism is deferred until a client exists.** | 1.8 leaves two viable options open; nothing built now forecloses either. |
| D-12 | **The instance-to-version ledger stays in the operator's private record.** | Moot until there is a fleet. Consequence accepted: a fleet gate cannot be CI-enforced. |

### Rejected, with reasons

- **`npm version` for releases** — trips the lockfile guard (1.8).
- **`railway up` as the routine update path** — cannot express a pinned
  release, and is the forbidden tier (1.8).
- **Relocating the runtime into this repository's own project (issue #90)** —
  superseded. Separation plus pinning addresses the property that made
  placement a concern.
- **Publishing to npm** — no consumer.
- **A local harness composing `verify-decision-runtime.mjs` with the
  setup-applier** — they target different products and do not compose. The
  verifier builds the runtime API image; the applier drives the wrapper's setup
  API. Any local profile work is dry-run validation already covered by tests.

---

## Part 3 — Target End State

### 3.1 Repository architecture

| Repository | Contains | Produces | Versioned |
| --- | --- | --- | --- |
| **decision-runtime** | `apps/{api,worker,mcp}`, `packages/{contracts,db,runtime-auth,mcp-service,decision-runtime-mcp,openclaw-adapter}` | three container services; an MCP endpoint as its only public surface | independently |
| **control-plane** | `packages/{openclaw-railway-installer,openclaw-setup-applier}`, root `Dockerfile`, `scripts/*.mjs` patches, `railway.toml` | the wrapper image; operator CLI | independently |
| **policy repo** (private, per company) | operating model in prose, the state contract, registrations, agent memory and state | the vocabulary an engine instance is loaded with, plus the MCP attachment declaration | independently |

No cross-repository code dependencies. The engine contains no company
vocabulary; the control-plane contains no runtime code; the policy repo
contains no engine code.

### 3.2 Infrastructure end state

```text
┌─ engine deployment (per instance) ──────────────┐
│  api + worker + mcp, one version, one Postgres  │
│  registrations loaded from the policy repo      │
└─────────────────────────────────────────────────┘
                    ▲ MCP attachment (declared in profile)
┌─ OpenClaw instance ─────────────────────────────┐
│  wrapper image, pinned via OPENCLAW_GIT_REF /   │
│  OPENCLAW_TEMPLATE_REF, snapshot-deployed       │
└─────────────────────────────────────────────────┘
```

- **Agency (canary):** engine tracks the release branch and updates
  automatically; wrapper stays pinned and updated deliberately.
- **Client instances:** engine pinned to a chosen version, updated
  deliberately; wrapper pinned; profile from that client's private repo. Pin
  mechanism decided when the first client exists (D-11).
- **No standing dev environment.** Fresh-provisioning verification is
  ephemeral: create, bootstrap, verify, destroy.

### 3.3 Update paths by environment and build

| Build | Trigger | Path | Reversal |
| --- | --- | --- | --- |
| Engine → agency canary | merge to the engine's main, green and version-bumped | tag, fast-forward release branch, service redeploys | Railway deployment rollback across all three services together; expand-contract and additive registrations are what make it safe |
| Engine → client instance | operator decision | move that instance to the chosen version | as above, within that instance only |
| Wrapper image → any instance | operator decision | pinned-ref update through the existing compare-and-swap helpers | revert the ref, redeploy |
| Profile → any instance | change in that client's policy repo | applied through the setup-applier, including the MCP attachment | re-apply the previous profile |
| Operator tooling | merge | nothing deploys; it is a CLI | n/a |

Each column moves independently. That independence is the point of the
separation: a change to the operating model, the engine, the wrapper, or the
tooling reaches an instance only through its own path, on its own schedule.

### 3.4 What must remain true

Invariants the implementation must not break, each traceable to a finding:

1. The engine contains no company vocabulary (1.3, 1.5, D-5).
2. API, worker, and MCP move together, always (1.2, D-2).
3. Governance data — registrations and authorization config — remains
   per-instance and is never written by a shared migration (1.3, 1.10).
4. Registrations are additive across any rollback window; status transitions
   are release-delayed (1.10).
5. Migrations are structural, fast, and expand-contract only (1.10).
6. No credential value is reproduced in writing, and secrets move by stdin or
   environment, never in an argument string
   (`docs/live-instance-operations.md` §3).
7. Documentation is written to public standard whether or not the repository is
   public (D-7).

---

## Open Items for the Implementation Plan

Deliberately not decided here, because they are sequencing questions rather
than architecture:

- Order of extraction, and whether the engine or the control-plane moves first.
- What duplicates across repositories (tsconfig base, CI scaffolding, lint
  config) and what is accepted as duplication.
- Which documents move with the engine, and what is left behind.
- Whether `verify:decision-runtime` and an upgrade-path check enter the CI gate
  at extraction time or after.
- Disposition of `Railway Proof Verify` (1.9): configure against the canary, or
  delete.
- Whether `ArtifactKindSchema` (1.5) is fixed during extraction or logged.
