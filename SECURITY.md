# Security Policy

## Supported Versions

This project is pre-1.0. Security fixes are handled on the default branch until
formal releases begin.

## Reporting a Vulnerability

Please do not open a public issue for secrets, auth bypasses, data exposure,
infrastructure access, or client-data handling bugs.

Use GitHub's private vulnerability reporting for this repository. Maintainers
must enable private vulnerability reporting before making the repository public.

If private vulnerability reporting is unavailable, open a minimal public issue
asking for a private disclosure channel without including vulnerability details.
Do not include tokens, proof-of-concept exploit steps, private URLs, or client
data in that public issue.

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
