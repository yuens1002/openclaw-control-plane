# Upstream selected transport fixtures

`v2026.9.4/` holds the unmodified OpenClaw completions transport from commit
`3a9d69db306cd7f081e06254cb89c4bcc14a7107` (tag `v2026.9.4`). Since v2026.9.x the
transport lives in the `@openclaw/ai` workspace package, split across two files:

| Fixture | Upstream path | SHA-256 |
| --- | --- | --- |
| `openai-completions-transport.ts.txt` | `packages/ai/src/transports/openai-completions-transport.ts` | `aed08a98d7b5af914901b34ed0435aad8982f9f9d01c217954cbb8eaac46d39d` |
| `openai-completions-stream.ts.txt` | `packages/ai/src/transports/openai-completions-stream.ts` | `66dda2b657026cc7028027dd2113fbd59fff7f6f398c1962303cb6b58c58d3e5` |

Source: https://github.com/openclaw/openclaw/tree/3a9d69db306cd7f081e06254cb89c4bcc14a7107/packages/ai/src/transports

Retained for source-hash, anchor, CLI and syntax checks. Execution-path testing
uses the built upstream resolver and transport with a synthetic network server,
not functions extracted from these fixtures. Upstream is MIT licensed;
see LICENSE in this directory. Update only with deliberate upstream pin review.
