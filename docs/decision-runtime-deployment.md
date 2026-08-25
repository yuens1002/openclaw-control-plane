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
  bootstrap failure starts a health-only process with `api: unavailable` and
  the failed persistence dimensions; operational routes remain unavailable.
- Set `RUNTIME_AUTH_CONFIG_JSON` to a secret-backed configuration satisfying
  `docs/runtime-authentication.md`. Production startup fails without it.
- Keep `RUNTIME_ENABLE_BASIC_AUTH` unset in production. Startup rejects an
  explicitly enabled value.
- Readiness reports database, migrations, registry, identity configuration, and
  required JWKS independently. It returns no issuer keys, principals, grants,
  tokens, or connection values.
- Bearer-authenticated adapters reject plaintext HTTP by default. Local or
  private-network development requires an explicit insecure-transport opt-in;
  production endpoints, issuers, and JWKS URLs use HTTPS.

## Optional worker

`deploy/decision-runtime/worker.Dockerfile` and `worker.railway.toml` provide an
independently deployable workflow-neutral worker process. It validates the same
database, migration, registry, identity, and JWKS dependencies and exposes only
`/health`; consumer handlers and registrations remain external. Deploy the API
and allow its migrations to complete before starting the optional worker. Keep
one API and one worker replica until migrations are moved into a separate
release job.

## Smoke verification

Run the public container, restart, and recovery verifier with:

```sh
npm run verify:decision-runtime
```

It builds the production API image, starts disposable PostgreSQL and local-JWKS
fixtures, performs authenticated command/query/restart checks, compares a
`pg_dump`/`pg_restore`, rebuilds the restored projection, and removes its
containers and network on exit. Ports can be overridden with the
`RUNTIME_VERIFY_*_PORT` variables.

Against a newly migrated database, use a deterministic test issuer or a
deployment-approved issuer to:

1. create an `example.observation` event;
2. derive an `example.state.reconcile` work item from that event;
3. execute `example.state.reconcile` with one idempotency key;
4. read the action, non-artifact result, and provenance edges;
5. execute `example.report.generate` and confirm its output remains typed as an
   artifact rather than a generic result;
6. repeat the command and confirm the operation reference is replayed;
7. restart the API and repeat the reads.

The same flow must fail before persistence with an invalid token, an unknown or
retired registration, changed idempotent content, or mismatched approval.

## Backup and restore

Use PostgreSQL-native, version-matched tools and secret-injected connection
strings. A portable logical backup is:

```bash
pg_dump --format=custom --no-owner --no-acl "$DATABASE_URL_UNPOOLED" --file runtime.dump
```

Restore only into an empty recovery database:

```bash
pg_restore --exit-on-error --no-owner --no-acl --dbname "$RECOVERY_DATABASE_URL" runtime.dump
```

Before directing traffic to the restored database, start the reviewed runtime
image against it and verify readiness, registration parity, record/edge counts,
idempotent replay, approval lookup, audit history, and deterministic projection
rebuild. Treat the backup as sensitive and apply the same retention and access
controls as the source database.

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
An application rollback does not reverse additive migrations. A data rollback
therefore restores a verified backup or point-in-time snapshot into a separate
database, validates it, then switches the runtime connection under an explicit
operator change window.
