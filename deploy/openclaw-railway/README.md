# OpenClaw on Railway

Use OpenClaw's Railway-recommended template instead of deploying the raw
`ghcr.io/openclaw/openclaw` image directly. The template runs a Railway wrapper
that listens on the public port, stores state on `/data`, serves `/setup`, and
proxies the Control UI at `/openclaw`.

## One-Command Install

From a Railway-linked project directory:

```powershell
.\deploy\openclaw-railway\install-template.ps1
```

The script:

- deploys the `clawdbot-railway-template` marketplace template
- generates `SETUP_PASSWORD` and `OPENCLAW_GATEWAY_TOKEN`
- reuses an existing healthy template service on rerun
- waits for the newest deployment to reach `SUCCESS`
- updates the generated Railway domain to target port `8080`
- verifies `/setup/healthz`
- writes `.env.local` and `openclaw-railway-handoff.local.md`
- prints the setup URL and setup password for the current run

This install path is intentionally a shell Chief of Staff install. It brings up
OpenClaw, setup auth, public routing, and persistent state, but it does not
install, enable, or assume any client-specific pipeline, connector, service, or
workflow. Client tools and workflows should be attached after the shell install
from the client's private source of truth.

The template source is an upstream runtime dependency of this public control
plane, not a client workflow repository. A Railway service connected to the
template can be used as a proof instance for the shell setup; client-specific
workflows or plugins should be connected separately after the baseline is
healthy.

For the public proof instance, prefer connecting Railway to
`yuens1002/openclaw-control-plane@main` and letting this repo's root
`railway.toml`/`Dockerfile` pull the pinned wrapper commit. That keeps the
public repo as the auditable Railway source while preserving the OpenClaw
runtime routes supplied by the wrapper:

- `/setup/healthz`
- `/setup`
- `/openclaw`

The live proof should not be a deployment of the TypeScript API shell alone, and
it should not source `vignesh07/clawdbot-railway-template` directly except as the
pinned dependency declared in `template-lock.json`.

If Railway retains historical template metadata on a service that was originally
created from `vignesh07/clawdbot-railway-template`, treat that as provenance,
not active source ownership. The clean proof setup is a Railway service created
from, or reconnected directly to, `yuens1002/openclaw-control-plane@main`, with
no active upstream URL pointing at `vignesh07`. The `vignesh07` repo should
appear only as the pinned wrapper dependency in this repo's Dockerfile and lock
file.

## Template Pinning and Updates

This repo pins the verifiable upstream template ref in
`template-lock.json`. The weekly GitHub Action runs:

```bash
npm run railway-template:check
```

The end-state proof verifier runs:

```bash
npm run railway-proof:verify
```

Without Railway environment variables it checks the source-owned runtime
contract. With `RAILWAY_PROJECT_ID`, `RAILWAY_ENVIRONMENT_ID`,
`RAILWAY_SERVICE_ID`, and `RAILWAY_PROOF_URL`, it also checks the live Railway
deployment source, active domain, and OpenClaw wrapper endpoints.

The scheduled GitHub proof workflow sets `RAILWAY_PROOF_LIVE_REQUIRED=true`, so
missing Railway secrets/vars fail the workflow instead of silently falling back
to source-only checks. Configure repository secrets for the Railway IDs/token
and repository variable `RAILWAY_PROOF_URL` for autonomous weekly verification.

If the upstream ref has moved, the check fails and reports the pinned commit and
latest upstream commit. It does not update the lock automatically. Bump the lock
only after a Railway proof smoke confirms `/setup/healthz`, `/setup`,
`/openclaw`, domain/port behavior, and persistent `/data` state still work.

For an immutable proof instance, eject or mirror the upstream template into an
OpenClaw-controlled GitHub repo and point Railway at an approved branch such as
`openclaw-control-plane-approved`. Advance that branch only through a reviewed
PR after the smoke test passes.

The setup password is needed for HTTP Basic auth on `/setup` and `/openclaw`.
Use any username.

Both local output files are ignored by git. They are handoff conveniences, not
source artifacts.

Useful options:

```powershell
.\deploy\openclaw-railway\install-template.ps1 -SetupUsername client-admin
.\deploy\openclaw-railway\install-template.ps1 -ForceNew
.\deploy\openclaw-railway\install-template.ps1 -NoLocalFiles
.\deploy\openclaw-railway\install-template.ps1 -HandoffPath "client-handoff.local.md"
```

## Manual Install

```powershell
railway deploy -t clawdbot-railway-template `
  -v "SETUP_PASSWORD=<generated-setup-password>" `
  -v "OPENCLAW_GATEWAY_TOKEN=<generated-gateway-token>"
```

After deployment, verify the service domain target port:

```powershell
railway domain list --service clawdbot-railway-template --json
railway domain update <domain> --service clawdbot-railway-template --port 8080 --json
```

Then open:

```text
https://<your-railway-domain>/setup
```

## Notes

- The template creates and mounts a Railway volume at `/data`.
- The wrapper healthcheck is `/setup/healthz`; public runtime status is `/healthz`.
- Do not deploy the raw OpenClaw image directly on Railway for this flow. It does
  not provide the wrapper behavior the hosted Control UI needs.
- Client installs should use a client-owned Railway project or workspace.
- Rotate temporary handoff credentials after onboarding if the client stores
  different long-term credentials.
