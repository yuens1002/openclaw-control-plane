# MCP Workload JWT Authentication Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/67
Branch: `feat/mcp-workload-jwt-auth`
Status: approved for implementation; verification pending

## Outcome

Allow the Decision Runtime MCP module to authenticate downstream with either
the existing OAuth 2.0 client-credentials provider or a deployment-held
asymmetric key that signs short-lived workload JWTs. This supports runtimes
that already trust a reviewed issuer/JWKS boundary without adding a bespoke
OAuth server.

The workload signer is a caller credential implementation, not an
authorization server, credential broker, or new authority boundary. The
Decision Runtime continues to verify JWTs, map principals, authorize actions,
bind approvals, and persist attribution.

## Current State

- The MCP module can acquire and cache OAuth client-credentials bearer tokens.
- `apps/mcp` requires OAuth endpoint/client variables in every mode.
- The runtime accepts short-lived asymmetric JWTs from configured issuers and
  JWKS documents, independent of how callers obtain those tokens.
- A deployment with static JWKS trust but no token endpoint cannot currently
  use the hosted MCP bridge without adding another identity service.

## Decisions

1. Add `MCP_DOWNSTREAM_AUTH_MODE` with `oidc-client-credentials` as the
   backwards-compatible default and `workload-jwt` as the new explicit mode.
2. Keep provider-specific configuration mutually exclusive. Startup rejects
   missing active-mode fields and credentials supplied for the inactive mode.
3. Workload JWT configuration requires exact issuer, subject, audience, key ID,
   algorithm, PKCS#8 private key, bounded lifetime, and refresh skew.
4. Support only asymmetric algorithms already accepted by the runtime:
   `RS256`, `RS384`, `RS512`, `ES256`, `ES384`, `ES512`, and `EdDSA`.
5. Validate the private key and algorithm family before transport startup.
6. Mint `iss`, `sub`, `aud`, `iat`, `exp`, `jti`, and protected `alg`/`kid`.
   Tokens live for 30-3600 seconds and refresh before expiry.
7. Reuse the existing bounded in-memory cache, concurrent refresh coalescing,
   invalidation, and one-retry-on-401 module behavior. Persist no token or key.
8. Keep production issuers HTTPS-only. Explicit development insecure mode may
   use only loopback issuer/runtime URLs.
9. Keep failures bounded and secret-safe. No private key, token, or provider
   credential enters errors, logs, readiness, or documentation fixtures.
10. Update public deployment and rotation guidance for both providers without
    naming a consumer, principal, tenant, or live endpoint.

## Deliverables

| ID | Deliverable | Owner | Artifacts |
| --- | --- | --- | --- |
| D1 | Workflow contract | project-manager | plan, ACs, and review record |
| D2 | Workload JWT provider | security | schema, key validation, signing, cache, and redacted failures |
| D3 | Discriminated app configuration | backend-architect | environment parsing and explicit provider composition |
| D4 | Security and integration conformance | test-engineer | deterministic signing, runtime verification, invalid configuration, cache, concurrency, health, and regression tests |
| D5 | Portable operator guidance | project-manager | authentication, rotation, deployment, and rollback documentation |
| D6 | Exact-head verification and release | test-engineer | executed evidence, review verdict, version, PR, CI, and external review |

## Implementation Sequence

1. Commit this plan and the role-owned AC contract.
2. Add failing provider and configuration tests.
3. Implement the signer and discriminated composition.
4. Add runtime-verification and hosted-health conformance.
5. Update generic docs and deployment-variable references.
6. Run focused tests, full tests, typecheck, build, production audit, Docker
   build, secret/public-language scan, and `git diff --check`.
7. Record exact-head QC and review, bump the minor version, open a PR, complete
   CI/Copilot review, and merge only on a clean reviewed head.

## Non-Goals

- Building an OAuth or OpenID Provider.
- Accepting symmetric keys, long-lived static bearer tokens, or raw database
  credentials.
- Changing MCP inbound authentication or runtime authorization.
- Dynamic issuer discovery, key publication, credential brokerage, proxying,
  or federation.
- Adding deployment-specific identities, endpoints, or secrets to this repo.

## Release Gates

- Every D1-D6 deliverable has executable or inspectable AC coverage.
- Existing OAuth behavior remains backwards compatible.
- Workload JWTs pass the runtime's real verifier against deterministic JWKS.
- Invalid keys/configuration fail before a transport listens.
- Secret-bearing sentinel values are absent from all public failures.
- The production MCP image retains no database dependency and passes health
  with both supported downstream authentication modes.
- Exact-head QC, human approval, CI, and Copilot review are clear before merge.
