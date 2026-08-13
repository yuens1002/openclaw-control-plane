# Security Policy

## Supported Versions

This project is pre-1.0. Security fixes are handled on the default branch until
formal releases begin.

## Reporting a Vulnerability

Please do not open a public issue for secrets, auth bypasses, data exposure,
infrastructure access, or client-data handling bugs.

For now, contact the repository owner directly through GitHub. Once the project
is public and has a dedicated disclosure channel, this file should be updated
with that address and expected response times.

## Secret Handling

Never commit:

- `.env` or `.env.local`
- Railway setup passwords or gateway tokens
- provider API keys
- OAuth tokens
- client data
- generated client handoff artifacts
- `*.local.md` files

Before making the repository public, run a working-tree and git-history secret
scan and rotate any secret that may have been exposed.
