# Runtime Authentication And Authorization

The typed-work API uses OIDC JWT bearer tokens in production. A deployment
supplies a versioned identity and static-policy document through the secret
environment variable `RUNTIME_AUTH_CONFIG_JSON`; the repository contains only
workflow-neutral `example.*` fixtures.

## Configuration contract

The document declares:

- trusted issuers, JWKS URLs, audiences, allowed signature algorithms, and a
  bounded clock-skew allowance;
- stable principal mappings keyed by the validated `(issuer, subject)` pair;
- configured actors and roles for each principal;
- exact authorization-action and resource grants;
- optional, explicitly bounded on-behalf-of delegations;
- the `static-rbac-v1` provider and an operator-controlled policy version.

Mutable token claims such as display name and email are attributes, not
identity. Configuration validation fails startup for duplicate external
identities, unknown issuers or roles, invalid delegation targets, unsupported
algorithms/providers, and an empty production trust configuration.

## Request boundary

Send `Authorization: Bearer <token>` to every `/v1/runtime` route. A caller may
request configured delegation with `X-On-Behalf-Of-Principal`, but the header
does not grant authority: both the authenticated principal's roles and the
matching delegation must allow the route's authorization action.

The server derives principal, effective actor, delegation, policy decision,
request ID, digest, and timestamps. Request bodies containing trust fields are
rejected by strict schemas. Denied requests are written through the bounded
runtime denial-audit operation and cannot create work or effects.

The API exposes registered event/work-item intake, immutable command approvals,
command execution, registrations, records, stream pages, provenance edges,
projections, and audit history under `/v1/runtime`. Pages are capped at 100
records. Errors use `{error: {code, message, request_id}}` and never include
tokens, key material, or private policy content.

## Development Basic Authentication

Legacy shell Basic Authentication is available only when
`RUNTIME_ENABLE_BASIC_AUTH=true` and `SETUP_PASSWORD` is set. Production startup
rejects that combination. Basic Authentication is not accepted as typed-runtime
identity and must not be used as a production trust mechanism.

## Key rotation

1. Publish the new public key in the issuer JWKS while retaining the current key.
2. Wait at least one configured verifier cache interval and verify `/health`
   reports `jwks: ready`.
3. Begin signing new tokens with the new `kid` and verify an authenticated
   typed-runtime read.
4. Remove the retired public key only after all tokens signed by it have expired.
5. Confirm a new-key token succeeds and a retired-key token fails before closing
   the rotation.

Unknown keys cause a bounded JWKS refresh; they do not permit an unbounded fetch
per request. Authentication failures intentionally return one generic public
message.
