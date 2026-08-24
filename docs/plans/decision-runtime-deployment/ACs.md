# Private Decision Runtime Deployment Acceptance Criteria

Plan: `docs/plans/decision-runtime-deployment/plan.md`

| ID | Acceptance criterion | Executable pass condition | Agent | QC | Reviewer |
| --- | --- | --- | --- | --- | --- |
| AC-IMAGE-001 | Dedicated runtime image | Container starts compiled `apps/api` and not the OpenClaw wrapper. | pass | pending | pending |
| AC-IMAGE-002 | Secret-safe context | Docker ignore tests cover `.env*`, local handoffs, `.git`, dependencies, and build output. | pass | pending | pending |
| AC-RAILWAY-001 | Dedicated service config | Config selects the decision-runtime Dockerfile, `/health`, and fail-closed restart behavior; the release procedure starts one replica. | pass | pending | pending |
| AC-DB-001 | Split connections | Restricted runtime role succeeds only because migrations use the supplied direct URL. | pass | pending | pending |
| AC-DB-002 | Startup readiness | Missing URL or failed database/migration/registry readiness prevents listening. | pass | pending | pending |
| AC-API-001 | Write boundary | `/events` remains unavailable without trusted command context. | pass | pending | pending |
| AC-REGRESSION-001 | OpenClaw unchanged | Root OpenClaw deployment files have no behavioral diff. | pass | pending | pending |
| AC-DOCS-001 | Generic operations | Docs explain connection, migration, readiness, and rollback without naming a tenant or provider-specific deployment. | pass | pending | pending |
| AC-CONFORMANCE-001 | Full verification | PostgreSQL tests, full tests, typecheck, build, Docker build, production audit, and diff checks pass. | pass | pending | pending |
