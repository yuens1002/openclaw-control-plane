# GitHub Installation Connector Transport — Plan

## Cadence

Full cadence (docs convention only — this repo has not opted into the
hook-enforced `verification-status.json` state machine, so gates below are
run and recorded manually rather than blocked mechanically). Follows
`docs/plans/workspace-identity-transport/` as the structural precedent —
same content/transport split, same deliberately-cut scope discipline.

## Goal

Deliver the **transport primitive** for granting the agency's CoT
least-privilege, short-lived GitHub access: a function that signs a
GitHub App JWT and exchanges it for a scoped installation access token —
following ADR 0001 (Identity and Communication Boundary), decision (4):
short-lived tokens minted per use, never a long-lived static secret handed
to the CoT.

## Scope note — what this plan does NOT cover

Ownership splits the same way `workspace-identity-transport` split #20:
the **profile repo** (`[private-repo]`, private) owns the
*content* — [issue #4](https://github.com/[private-org]/[private-repo]/issues/4)'s
App registration, the two installations (agency org + personal account),
and recording granted repos/timestamps as an identity record. **This
repo** (`openclaw-control-plane`) owns the *transport* — signing the JWT
and exchanging it for a token, given an installation id someone else
supplies. This plan is scoped to transport only, and further cut down
from that:

- No `listInstallations` / `listInstallationRepositories`. Both would be
  exercised against a live App that doesn't exist yet (issue #4's
  registration is the operator's own follow-up, not done). Untestable
  surface isn't shipped; see Non-Goals.
- No repo-subset scoping (`repositories`/`repository_ids` on the mint
  request) — same reason, deferred with the above.
- No CLI. Nothing real to invoke it against yet — matches
  `workspace-identity-transport`'s own "no wiring in, nothing real to
  pass yet" Non-Goal verbatim.
- No audit-event wiring (`POST /events`). `apps/api`'s event store is
  `InMemoryEventStore` today (`GET /health` reports
  `"database": "not_connected"`) — not durable. ADR 0001 asks for a
  durable audit trail; wiring against a non-durable store means writing
  the audit path twice once real persistence lands. Named as the top
  follow-up, not silently dropped.
- No dependency on, or read of, the profile repo's JSON at all. The
  installation id is a direct caller-supplied parameter. "Tenant"
  (agency/personal) is profile-repo vocabulary, not transport vocabulary.
- No GitLab (or other host) connector in this pass — see Package below
  for why the package is scoped to make one an easy sibling addition
  later, without shipping any abstraction for it now.

## Background (confirmed against GitHub's documented contract, not a live call)

No GitHub App exists yet to test against (issue #4's registration is
still pending, an operator/browser action). Everything below is taken
from GitHub's published REST API docs, **not confirmed live**:

- **JWT**: `RS256`, header `{alg: "RS256", typ: "JWT"}`, payload `{iat,
  exp, iss}` — `iss` is the numeric App id (as a string), `iat` backdated
  ~60s for clock drift, `exp` ≤ 10 minutes out. Node's `node:crypto`
  (`createSign("RSA-SHA256")`, base64url encoding — natively supported by
  `Buffer.toString("base64url")` since Node 15.7, well under this repo's
  `engines.node >= 20` floor) covers this without a dependency.
- **Token exchange**: `POST https://api.github.com/app/installations/{installation_id}/access_tokens`,
  `Authorization: Bearer <jwt>`, `Accept: application/vnd.github+json`,
  `X-GitHub-Api-Version: 2022-11-28`. Documented response fields:
  `token`, `expires_at` (ISO 8601, snake_case — **not** confirmed live;
  this repo already has one burned precedent for exactly this class of
  mistake — `openrouter-provisioning.ts`'s `data.hash` nesting comment —
  where a guessed-not-confirmed response shape orphaned a real key on
  first live use), `permissions`, `repository_selection`. Parsing throws
  loudly on a missing/malformed field rather than silently returning
  `undefined`, so a live shape mismatch fails the first real call instead
  of shipping a token-shaped object with a missing field.
- **Token custody**: mirrors `openrouter-provisioning.ts`'s discipline
  exactly — the function never logs, prints, or persists the token; it is
  returned to the one caller responsible for using it, and nowhere else.
  This mint call is real, billable-adjacent (rate-limited, and a minted
  token is live/usable for up to an hour), and irreversible in the sense
  that a token can't be un-minted — tests must stub `fetchImpl`, never
  call the real endpoint.

## Package

New package: `packages/openclaw-source-control-connector`. Neither
existing candidate is a clean fit — `openclaw-setup-applier`'s charter is
"drives a live OpenClaw instance's `/setup` API" (unrelated to GitHub
access) and `openclaw-railway-installer`'s is Railway instance
provisioning (also unrelated) — and this module needs zero imports from
either package's other modules (just `node:crypto` + `fetch`), so neither
placement avoids looking foreign. Named after the **category** ADR 0001
(4) uses — "source-control access" — not the single provider, so a future
contributor adding GitLab support adds
`gitlab-installation-provisioning.ts` as a sibling file in this same
package, not a new package or an awkward extension of an unrelated one.
No shared interface/base class ships for that hypothetical yet — this is
a package-boundary decision, not a speculative abstraction.

## Design

New module `packages/openclaw-source-control-connector/src/github-installation-provisioning.ts`:

```ts
export function buildAppJwt(appId: string, privateKeyPem: string, now?: () => Date): string

export interface MintInstallationTokenOptions {
  appId: string;
  privateKeyPem: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface MintedInstallationToken {
  token: string;
  expiresAt: string;
  permissions: Record<string, string>;
}

export async function mintInstallationToken(
  installationId: string,
  options: MintInstallationTokenOptions
): Promise<MintedInstallationToken>
```

- `buildAppJwt` is pure and synchronous — no network call — so it's
  independently testable via a real generated RSA keypair
  (`crypto.generateKeyPairSync`) and `crypto.verify`, proving the
  signature round-trips correctly without needing a live GitHub call.
- `mintInstallationToken` calls `buildAppJwt`, then `fetchImpl` (default
  global `fetch`) against the documented endpoint, throws
  `GitHubProvisioningError` (mirroring `OpenRouterProvisioningError`) on a
  non-`ok` response, and throws a distinct parse error naming the missing
  field if `token`/`expires_at`/`permissions` aren't present in the
  expected shape.
- `package.json` `exports`: `"./github-installation-provisioning": "./src/github-installation-provisioning.ts"`,
  matching every sibling package's export-per-file convention.
- No new dependency — `node:crypto` + `fetch` only.
- **Module resolution is `paths`-mapped, not wildcard** (confirmed by
  reading `tsconfig.base.json`): every cross-package import in this repo
  resolves through an explicit per-export entry in
  `tsconfig.base.json`'s `compilerOptions.paths`, which is also what
  `vitest.config.ts`'s `vite-tsconfig-paths` plugin keys off for test
  imports. Three files need an entry, not one:
  - Root `tsconfig.json`'s `references` array gains
    `{ "path": "./packages/openclaw-source-control-connector" }`.
  - `tsconfig.base.json`'s `paths` gains
    `"@openclaw-control-plane/openclaw-source-control-connector/github-installation-provisioning": ["packages/openclaw-source-control-connector/src/github-installation-provisioning.ts"]`.
  - `tests/tsconfig.json`'s own `references` array (separate from root's —
    `tests` is its own composite project) gains
    `{ "path": "../packages/openclaw-source-control-connector" }`.
  Both AC-REG-2 (typecheck/build) and AC-TEST-001 (import via the
  `exports` path) depend on all three; missing any one fails resolution
  under `tsc -b` even if `npm install` has already symlinked the
  workspace package.

## Deliverables (with spec-role assignment)

| ID | Deliverable | Kind | Owning role |
| --- | --- | --- | --- |
| D1 | Plan and ACs docs | docs | `/project-manager` |
| D2 | New package scaffold (`package.json`, `tsconfig.json`) + `github-installation-provisioning.ts` (`buildAppJwt`, `mintInstallationToken`) + the three resolution-wiring files (root `tsconfig.json` references, `tsconfig.base.json` paths, `tests/tsconfig.json` references) | script | `/devops` |
| D3 | Mocked tests — JWT round-trip via a generated keypair, mint call-through with injected `fetchImpl`, non-`ok` response error, malformed-response-shape error | test | `/test-engineer` |
| D4 | Docs update | docs | `/project-manager` |

## Commit Schedule

1. `docs: add plan and ACs for github-installation-connector`
2. `feat(source-control-connector): add github installation token minting transport`
3. `test(source-control-connector): cover JWT signing + token mint transport`
4. `docs: document the github installation connector transport primitive and #4 scope split`

## Non-Goals

- No `listInstallations`/`listInstallationRepositories` — deferred until
  a real App exists to test against (issue #4's registration, not done).
- No repo-subset scoping on the mint request — deferred with the above.
- No CLI — nothing real to invoke it against yet; the next iteration adds
  one once issue #4's registration produces a real installation id.
- No audit-event wiring (`POST /events`) — `apps/api`'s event store is
  in-memory, not durable; wiring now means writing the durable audit path
  twice later. **Top follow-up once Postgres-backed event storage lands.**
- No read of, or coupling to, `[private-repo]`'s schema or
  data — installation id is a plain caller-supplied parameter.
- No live-call confirmation of GitHub's response field names
  (`expires_at` etc.) — taken from documented contract only; parsing
  fails loud on a shape mismatch rather than silently accepting one.
- No GitLab (or other host) module — package is scoped to make this an
  easy future addition, not built speculatively now.
- No change to `[private-repo]` (issue #4's own repo).

## Handoff note

An earlier planning pass in this session mistakenly started this same
work in `[private-repo]` (branch `feat/github-installation-connector`
there, one commit `1f28278`, unpushed). That repo has been switched back
to `main`; the stray branch/commit is left in place, untouched, for the
operator to keep or delete — not deleted automatically.
