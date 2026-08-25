# Private Decision Runtime Deployment Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/53
Branch: `feat/decision-runtime-deployment`
Status: approved for implementation

> Historical scope note: issue #53 deliberately shipped before transport
> authentication. Issue #39 later supplied the production OIDC/policy boundary;
> the current service contract lives in `docs/runtime-authentication.md`.

## Outcome

Ship a dedicated production target for the private decision-runtime API without
changing the root OpenClaw deployment. The service owns PostgreSQL migrations,
registry synchronization, and durable runtime access while operational writes
remained fail-closed pending the separately scoped authentication work.

## Deliverables

| ID | Deliverable | Evidence |
| --- | --- | --- |
| D1 | Secret-safe Docker context and compiled decision-runtime image | Docker build and image inspection |
| D2 | Dedicated Railway service configuration with `/health` readiness | configuration tests |
| D3 | Pooled runtime/direct migration connection split | restricted-role PostgreSQL test |
| D4 | Generic deployment, rollback, and first-migration documentation | public-boundary review |
| D5 | Exact-head verification and independent review | tests, build, diff check, review |

## Implementation Order

1. Add failing configuration and split-connection tests.
2. Refactor runtime bootstrap to accept a direct migration URL separately.
3. Add the compiled Docker image, ignore rules, and Railway configuration.
4. Add generic operator documentation.
5. Run PostgreSQL, full-suite, typecheck, build, Docker, and static checks.
6. Complete independent exact-head review before merge or production creation.

## Release Gates

- The root OpenClaw Dockerfile and `railway.toml` remain behaviorally unchanged.
- No local secret can enter the Docker build context.
- Migrations run before the server listens and use the direct connection when supplied.
- The application pool uses the runtime connection.
- Missing or invalid database readiness prevents startup.
- No unauthenticated operational write is enabled.
- Production creation uses committed GitHub source, one initial replica, and post-deploy readiness verification.
