# OpenClaw on Railway

This directory is a Railway deploy target for a hosted OpenClaw Gateway + Control UI.

It wraps the official OpenClaw container image and keeps the Railway-specific contract in code:

- Gateway port: `8080`
- Persistent volume mount: `/data`
- State directory: `/data/.openclaw`
- Workspace directory: `/data/workspace`
- Healthcheck: `/healthz`

## Railway Setup

Create a Railway service from the GitHub repo and set the service root directory to:

```text
deploy/openclaw-railway
```

Attach a Railway volume mounted at:

```text
/data
```

Set these service variables:

```text
OPENCLAW_GATEWAY_PORT=8080
OPENCLAW_GATEWAY_TOKEN=<generated-admin-secret>
OPENCLAW_STATE_DIR=/data/.openclaw
OPENCLAW_WORKSPACE_DIR=/data/workspace
OPENCLAW_DISABLE_BONJOUR=1
```

Enable Public Networking with HTTP Proxy on port `8080`.

After deploy, open:

```text
https://<your-railway-domain>/openclaw
```

Connect using `OPENCLAW_GATEWAY_TOKEN`.

## Generate a Gateway Token

Do not commit the token. Generate it locally and paste it into Railway Variables:

```powershell
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
```

## Post-Deploy Preflight

From Railway shell:

```bash
openclaw doctor --json
```

## Notes

- Railway injects `PORT`, but OpenClaw expects `OPENCLAW_GATEWAY_PORT`; keep both Railway public networking and `OPENCLAW_GATEWAY_PORT` aligned at `8080`.
- The `/data` volume is required for persistent OpenClaw state, auth profiles, sessions, plugin installs, and workspace files.
- External connectors, channels, and provider credentials should be configured after the gateway is reachable.
