# Private Decision Runtime Deployment

The decision runtime is deployed as a private sibling service beside an existing
OpenClaw service. It owns the runtime API process and database migrations without
changing the OpenClaw image or exposing a public domain.

## Service contract

- Build with `deploy/decision-runtime/Dockerfile` and
  `deploy/decision-runtime/railway.toml`.
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

Deploy only from a reviewed commit on the repository's default branch. Verify
the platform health check, startup logs, migration ledger, and runtime registry
before directing any caller to the service.

Application rollback means redeploying the prior reviewed image. Database
migrations are additive and are not reversed automatically. If a data rollback
is required, restore through the database provider's backup or point-in-time
recovery procedure, then verify readiness before resuming the service.
