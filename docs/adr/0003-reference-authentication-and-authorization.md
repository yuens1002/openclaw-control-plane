# ADR 0003: Reference Authentication and Authorization Boundary

## Status

Accepted and implemented

## Context

ADR 0002 defines a durable typed-work service that accepts a trusted command
context. It intentionally does not let request payloads assert identity,
delegation, or authorization. A public reference adapter therefore needs a
concrete, testable way to authenticate callers, resolve stable principals,
evaluate policy, and pass trusted context to the service without prescribing a
particular identity vendor or consumer organization.

Development-only Basic Authentication is insufficient for that role: it does
not provide issuer-scoped identities, key rotation, delegated identity, or a
portable production trust contract.

## Decision

### 1. Use OIDC JWT bearer tokens as the reference transport mechanism

The reference HTTP and tool adapters validate JWT bearer tokens against a
configured OpenID Connect issuer and its JWKS. Validation includes signature,
issuer, audience, expiry, not-before time, and an explicit clock-skew limit.
Unknown issuers, algorithms, keys, or audiences fail closed.

The stable external identity key is `(issuer, subject)`, using the validated
`iss` and `sub` claims. Display names, email addresses, and other mutable claims
are attributes, not identity keys.

Basic Authentication may remain available behind an explicit development-only
flag. It is disabled in the production profile and is not part of the reference
production trust model.

### 2. Configure issuer and principal mappings with a public schema

The adapter loads versioned configuration with this logical shape:

```yaml
config_version: 1
issuers:
  - issuer: https://issuer.example
    jwks_uri: https://issuer.example/.well-known/jwks.json
    audiences:
      - control-plane
    allowed_algorithms:
      - RS256
    clock_skew_seconds: 30
principals:
  - issuer: https://issuer.example
    subject: stable-subject
    principal_id: principal://example/service
    actor:
      type: service
      id: example-service
    roles:
      - work.submitter
roles:
  - name: work.submitter
    grants:
      - authorization_action: state.reconcile
        resources:
          - type: example.environment
            id: "*"
delegations:
  - authenticated_principal_id: principal://example/service
    on_behalf_of_principal_id: principal://example/operator
    allowed_authorization_actions:
      - state.reconcile
authorization_policy:
  provider: static-rbac-v1
  policy_version: example-policy-v1
```

Secrets and private keys are referenced through the deployment secret provider;
they are never embedded in this configuration or returned by an API.
Configuration is validated at startup. Duplicate external identities, unknown
roles, invalid delegation targets, and unsupported policy providers fail
readiness.

The static-RBAC provider evaluates the operation registration's
`authorization_action`, not its `operation_type`. A resource has the same
`{type, id}` subject shape used by ADR 0002. Actions and resource types match
exactly. A resource ID matches exactly unless a grant uses the complete value
`"*"`, which matches every ID of that resource type; partial globs are not
supported. Grants are additive, there are no explicit deny rules, and no
matching grant means denied. Delegation must independently allow the same
`authorization_action`; it cannot create authority the authenticated
principal's roles do not already grant.

### 3. Keep policy evaluation behind a stable interface

The reference policy boundary is:

```text
authorize({
  authenticated_principal,
  on_behalf_of_principal,
  action,
  resource,
  request_origin
}) -> {
  decision_id,
  result,
  policy_version,
  reason_codes
}
```

`result` is `allowed` or `denied`. The adapter constructs ADR 0002's trusted
command context only from validated identity, configured mappings, and this
decision. Consumer payload fields cannot override any of them.

The public reference implementation is a versioned static RBAC provider. The
interface permits another policy engine to be injected without changing the
typed-work service or persisted attribution shape.

### 4. Audit denial through the bounded service operation

An allowed request calls the requested typed-work service operation with the
trusted command context. A denied request calls ADR 0002's bounded
`recordAuthorizationDecision` operation. That operation records the attempted
action, resource, principal/delegation, policy version, decision ID, and reason
codes but cannot create work, an action attempt, or an effect.

Adapters never write audit storage directly.

### 5. Ship deterministic public fixtures

The repository provides:

- A local test issuer/JWKS and signed JWT fixtures for valid, expired,
  wrong-audience, wrong-issuer, unknown-key, and rotated-key cases.
- `example.*` principal, role, delegation, resource, and policy fixtures.
- Tests proving stable principal resolution, fail-closed startup, actor-field
  spoof rejection, allowed and denied decisions, valid and invalid delegation,
  key rotation, and denial auditing without durable effects.
- A production-profile test proving that development Basic Authentication is
  disabled.

No fixture names a private consumer, deployment, repository, or organization.

## Consequences

- The public deployment profile has a concrete production authentication path
  while remaining independent of a specific identity provider.
- Stable principals and policy decisions are reproducible and auditable.
- Deployments can replace static RBAC through the public policy interface.
- OIDC issuer and JWKS availability become readiness and operational concerns.
- Consumer-specific principals, roles, and policy data remain deployment-owned.

## Alternatives Considered

- **Basic Authentication as the production reference.** Rejected because it
  lacks issuer-scoped identity, key rotation, and a useful delegation model.
- **Trust actor or role fields from the request.** Rejected because callers
  could assign themselves authority.
- **Require one hosted identity vendor.** Rejected because the public baseline
  should be portable.
- **Let adapters write denial audit rows directly.** Rejected because it would
  bypass the service contract and create a second persistence authority.
