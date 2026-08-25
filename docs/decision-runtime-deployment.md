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

## Build triggers

Both `deploy/decision-runtime/railway.toml` and
`deploy/decision-runtime/worker.railway.toml` declare `build.watchPatterns` —
gitignore-style path patterns, evaluated from the repository root regardless
of any root directory setting, that gate whether a commit creates a new
deployment for that service. A commit matching none of a service's patterns
skips a deployment for that service entirely; multiple patterns are OR'd
together, and neither file uses a negation pattern.

Each service's patterns cover exactly its Dockerfile's build-stage `COPY`
sources: its own app directory, its own Dockerfile and `railway.toml`, the
shared `packages/contracts`, `packages/runtime-auth`, and `packages/db`
(including migrations), the root dependency manifests and shared TypeScript
configuration, and `.dockerignore`. Root OpenClaw's `railway.toml` declares no
`watchPatterns` and continues to deploy on every commit to the tracked branch
— that is unchanged by this feature.

| Changed path | API deploys | Worker deploys |
| --- | --- | --- |
| `apps/api/**` | Yes | No |
| `apps/worker/**` | No | Yes |
| `packages/contracts/**`, `packages/runtime-auth/**`, `packages/db/**` (incl. migrations) | Yes | Yes |
| `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.base.json`, `.dockerignore` | Yes | Yes |
| `deploy/decision-runtime/railway.toml` or `deploy/decision-runtime/Dockerfile` | Yes | No |
| `deploy/decision-runtime/worker.railway.toml` or `deploy/decision-runtime/worker.Dockerfile` | No | Yes |
| Documentation, the OpenClaw wrapper, or an unrelated package | No | No |

**Maintenance rule**: whenever either Dockerfile gains another copied
source path — a new shared package, a new root manifest, a new build
argument file — add that path to the same service's `watchPatterns` in the
same change. An uncovered path silently stops triggering deployments for
real build-input changes; `tests/decision-runtime-watch-patterns.test.ts`
enforces this by deriving the expected pattern set directly from each
Dockerfile's `COPY` sources and asserting it matches the declared patterns.

**Verification procedure** (generic — run against any GitHub-connected
decision-runtime service, replacing no identifiers below):

1. Confirm both services' config-as-code path is set to their respective
   `deploy/decision-runtime/*.railway.toml`.
2. Push a commit touching only `apps/api/**` and confirm a new deployment
   appears for the API service and not the worker service.
3. Push a commit touching only `apps/worker/**` and confirm the reverse.
4. Push a commit touching only `packages/db/**` and confirm both services
   receive a new deployment.
5. Push a commit touching only documentation (for example, this file) and
   confirm neither service receives a new deployment.

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
