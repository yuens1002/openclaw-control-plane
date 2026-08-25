# Decision Runtime MCP Bridge Review

Plan: `docs/plans/decision-runtime-mcp/plan.md`

Implementation SHA: `ee7c7ec2c8036ecae7c61d9cbf4fafb4cca7cdcd`

Status: independent verification and main-thread QC passed; human approval is
pending before versioning or pull request publication.

## Verdict

PASS. No unresolved security, correctness, deployment, documentation, or public
repository blocker remains on the reviewed implementation SHA.

The final independent verifier compared the complete diff from
`69a6b842b5796555bf24c046566709fd25023e31`, inspected the plan and every AC,
and ran protocol, PostgreSQL, build, audit, and production-image evidence. Main
QC reviewed and transcribed the evidence into `ACs.md`.

## Delivered Boundaries

- `packages/mcp-service` supplies one explicit first-party module contract,
  deterministic registration, duplicate tool/module rejection, server-owned
  call context, bounded results/errors, stdio, stateless Streamable HTTP,
  bearer and Origin gates, health aggregation, and shutdown.
- `packages/decision-runtime-mcp` supplies exactly ten contract-backed runtime
  tools, short-lived OIDC client credentials, one bounded 401 refresh, safe
  runtime outcome translation, request timeouts, and invocation-ID forwarding.
- `apps/mcp` owns only validated configuration and explicit composition.
- `deploy/decision-runtime-mcp` is an independent image/profile with no
  database, migration, API, worker, consumer workflow, or private profile.
- ADR 0004 and `docs/mcp-service.md` document MCP versus HTTP, authority,
  OpenClaw configuration/filtering/probing, deployment, rollback, and the
  general proxy/federation non-goal.

## Executed Evidence

| Gate | Result |
| --- | --- |
| Focused MCP conformance | 39/39 passed |
| Full suite with disposable PostgreSQL | 396/396 passed; zero skips |
| Separate PostgreSQL suite | 28/28 passed; disposable container removed |
| TypeScript | `npm run typecheck` and `npm run build` passed |
| Production dependencies | `npm audit --omit=dev` reported zero vulnerabilities |
| Production image | Built successfully; only the five intended workspaces were present |
| Hosted lifecycle | Ready against stubs, invalid Origin rejected, ready after restart, degraded when upstream failed |
| Repository quality | `git diff --check`, public-language scan, and clean-worktree checks passed |

Official MCP clients exercised real stdio and hosted processes. The probes
confirmed exact ten-tool discovery, reviewed annotations, read and write calls,
fresh UUID attribution, unchanged runtime idempotency keys, strict inbound auth,
and stateless HTTP behavior. PostgreSQL tests confirmed durable attribution,
provenance, authorization, approval, conflict, audit, restart, and migration
behavior through the existing runtime boundary.

## Review Corrections

Two blocked independent passes preceded the final PASS. Their findings were
corrected and regression-tested:

1. Restricted insecure token/runtime endpoints to explicit loopback
   development use.
2. Made readiness actively prove token acquisition and runtime reachability.
3. Preserved validated runtime status, code, and request ID through MCP errors.
4. Applied the configured timeout to runtime HTTP calls.
5. Form-encoded OAuth Basic client credentials before Base64 encoding.
6. Enforced hosted MCP Origin allowlisting against DNS rebinding.
7. Replaced arbitrary structured errors with a strict non-secret public schema.
8. Rejected duplicate module IDs before health dimensions can collide.

## Residual Risks

- A real external OIDC provider may impose provider-specific audience, scope,
  or client-auth conventions beyond the deterministic public fixtures.
- A target OpenClaw deployment still needs its own tool allowlist, model-use
  policy, and evaluation before write tools are enabled for an agent.
- Railway service variables, domains, and the hosted service identity require a
  deployment-owned smoke test after adoption.

These are adoption checks outside this public implementation. They do not
justify embedding a private deployment or consumer policy in this branch.

## Human Gate

Review the implementation, AC evidence, ADR, public guide, and residual risks.
After approval, update the package minor version and changelog, commit the
verification/release metadata, publish the implementation PR, complete CI and
Copilot review, and merge only if the PR head remains unchanged and clean.
