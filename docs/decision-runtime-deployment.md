# Private Decision Runtime Deployment

The decision runtime is deployed as a private sibling service beside an existing
OpenClaw service. It owns the runtime API process and database migrations without
changing the OpenClaw image or exposing a public domain.

## Service contract

- Build with `deploy/decision-runtime/Dockerfile` and
  `deploy/decision-runtime/railway.toml`.
- Set the Railway service's config-as-code file path to the absolute repository
  path `/deploy/decision-runtime/railway.toml`. Railway otherwise discovers the
  root `railway.toml`, which belongs to the OpenClaw service.
- Start with one replica. Startup migrations must finish before the process
  listens, so additional replicas require a separate migration strategy.
- Set `DATABASE_URL` to the pooled connection used for normal runtime queries.
- Set `DATABASE_URL_UNPOOLED` to the direct connection used for startup
  migrations. If it is absent, migrations fall back to `DATABASE_URL`.
- Treat both connection strings as secrets. They belong on the runtime service,
  not in source control or the OpenClaw service.
- Use `/health` for deployment readiness. A database, migration, or registry
  readiness failure prevents the server from listening.

## Initial write boundary

The initial private deployment proves migrations and readiness only. Operational
write routes remain fail-closed until a trusted command context is supplied by
the service authentication and authorization work. Do not add a public domain
to bypass that boundary.

## Deploy and rollback

Create the service from the repository's default branch, select
`/deploy/decision-runtime/railway.toml` as its config-as-code path, and keep it
private with one replica. Deploy only from a reviewed commit. Verify
the platform health check, startup logs, migration ledger, and runtime registry
before directing any caller to the service.

Application rollback means redeploying the prior reviewed image. Database
migrations are additive and are not reversed automatically. If a data rollback
is required, restore through the database provider's backup or point-in-time
recovery procedure, then verify readiness before resuming the service.
