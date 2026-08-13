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
- waits for the newest deployment to reach `SUCCESS`
- updates the generated Railway domain to target port `8080`
- verifies `/setup/healthz`
- prints the setup URL and setup password

The setup password is needed for HTTP Basic auth on `/setup` and `/openclaw`.
Use any username.

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
