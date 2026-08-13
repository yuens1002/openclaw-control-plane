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
