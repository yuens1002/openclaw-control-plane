# Client Template Pinning ACs

Pass conditions are invariants over the emitted Railway CLI command
sequence against a fake `RailwayRunner`, never over live Railway state or a
pinned SHA literal (the pinned commit is read from
`template-lock.json`/`Dockerfile` at test-fixture-build time, never
hardcoded in a test or in this table).

| AC | Plan ref | Role | Pass invariant | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- | --- |
| AC-HELP-001 | D2 | devops | The extracted poll-until-success helper is generic over service name/poll/timeout and is used by both the existing marketplace install path and the new provisioner, with no behavior change to the existing path's tests. | | | |
| AC-HELP-002 | D2 | devops | `ensureDomainPort`, `healthCheck`, and `listServices` are exported from the installer package's public surface and importable by the new provisioner module without duplication. | | | |
| AC-RELOC-001 | D3 | devops | `readRailwayVariable`/`writeRailwayVariable`/`listRailwayVariables` live in `openclaw-railway-installer`; `openclaw-setup-applier`'s `./railway-variables` export re-exports them with no change to `apply-profile.ts`'s import path or behavior. | | | |
| AC-RELOC-002 | D3 | devops | `writeRailwayVariable`'s existing secret-safety property is preserved after the move: the value is passed via stdin, never appears in the emitted `args` array. | | | |
| AC-PROV-001 | D4 | devops | A fresh provision run against a name with no existing service emits, in order: `up --new` (detached), `service <name>`, `volume add --mount-path /data` with no `-s`/`--service` flag, then a `variable set` call per required key (`OPENCLAW_TEMPLATE_REF`, `PORT`, `OPENCLAW_STATE_DIR`, `OPENCLAW_WORKSPACE_DIR`, `SETUP_PASSWORD`, `OPENCLAW_GATEWAY_TOKEN`) each with `--skip-deploys`, then exactly one `redeploy --service <name> --yes`. | | | |
| AC-PROV-002 | D4 | devops | `OPENCLAW_TEMPLATE_REF` defaults to `template-lock.json`'s `pinnedCommit` when not explicitly passed by the caller, and is overridable per call. | | | |
| AC-PROV-003 | D4 | devops | The provisioner polls until the post-redeploy deployment reaches `SUCCESS`, and raises an actionable error (naming the service and pointing at `railway logs`) on a terminal failure status, mirroring the existing installer's failure-message shape. | | | |
| AC-PROV-004 | D4 | devops | If the domain's target port doesn't match the configured port, the provisioner corrects it before health-checking, and health-checks `/setup/healthz` before reporting success. | | | |
| AC-PROV-005 | D4 | devops | A rerun against a name with an existing healthy service skips steps 1–5 entirely (no `up`, `service`, `volume add`, `variable set`, or `redeploy` calls) unless a `forceNew`-equivalent option is passed. | | | |
| AC-PROV-006 | D4 | devops | On the skip-provisioning rerun path, the local handoff/env output reuses the service's actual `SETUP_PASSWORD` (read via `readRailwayVariable`), never a newly generated value. | | | |
| AC-PROV-007 | D4 | devops | Local handoff/env file writes stay confined to the existing ignored-file convention (`.env.local`-shaped path, `*.local.md`-shaped handoff path) and include the resolved `OPENCLAW_TEMPLATE_REF`. | | | |
| AC-PROV-008 | D4 | devops | (Issue #18 correction.) `SETUP_PASSWORD` and `OPENCLAW_GATEWAY_TOKEN` reach the fake runner's `stdin` argument byte-identical to the generated value — no `﻿` (BOM), no trailing `\r\n` — because the value flows JS-string-to-JS-string from `createSecret` through `writeRailwayVariable` into `runner.run(args, value)` with no PowerShell `\|` pipe anywhere in that path. | | | |
| AC-UPD-001 | D5 | devops | Given an existing service name and a new ref, the update path emits exactly two Railway calls: one `variable set OPENCLAW_TEMPLATE_REF --service <name> --skip-deploys` and one `redeploy --service <name> --yes` — no calls referencing any other service name. | | | |
| AC-UPD-002 | D5 | devops | The update path polls the named service to `SUCCESS`/terminal-failure the same way D4 does (shared helper from D2), and never touches `railway.toml`, `main`, or any other client's variables. | | | |
| AC-CLI-001 | D6 | devops | The CLI entrypoints parse their documented flags and reject unknown flags with a clear error, matching the existing `cli.ts` `parseArgs` convention. | | | |
| AC-CLI-002 | D6 | devops | Secret-shaped values (`SETUP_PASSWORD`, `OPENCLAW_GATEWAY_TOKEN`) accepted as CLI input are never echoed to stdout/stderr by the CLI layer itself. | | | |
| AC-PS-001 | D7 | devops | Each PowerShell wrapper is valid PowerShell (parses under `[System.Management.Automation.PSParser]::Tokenize` or equivalent) and delegates to `npm exec -- tsx <cli-entrypoint>` the same way `install-template.ps1` does, failing clearly if Node/npm is missing. | | | |
| AC-TEST-001 | D8 | test-engineer | Mocked tests exist and pass for: fresh provision command order (AC-PROV-001), idempotent rerun skip (AC-PROV-005), credential reuse on rerun (AC-PROV-006), and update-path scoping (AC-UPD-001). | | | |
| AC-TEST-002 | D8 | test-engineer | No test or fixture in this feature pins the Dockerfile's/`template-lock.json`'s current `pinnedCommit` SHA as a literal; tests read it from a fixture `template-lock.json` object defined in the test file, or assert override behavior with an arbitrary non-default test SHA. | | | |
| AC-DOCS-001 | D9 | project-manager | README/deploy docs describe when to use the new provisioning path vs. `install-template.ps1`, and explicitly note that `railway.toml`'s `[variables]` block is not applied by `railway up`, which is why the provisioner sets those keys explicitly. | | | |

## Gate 1 — Plan ↔ ACs coverage (manual check, no repo validator script exists)

Every deliverable D2–D9 has at least one AC row above (D1 is this pair of
docs and is self-covering). No AC row references a deliverable ID outside
D1–D9.

## Gate 2 — Anti-drift check (manual, no repo lint script exists)

No Pass-invariant cell above pins a config literal (pinned commit SHA,
generated secret value, a specific domain string) that also lives in
`template-lock.json`, `Dockerfile`, or generated test fixtures — each cell
states behavior over the fake runner's captured command sequence instead.
