# Upstream adapter fixture

`openai-completions.ts.txt` is the unmodified OpenClaw adapter from commit
`0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c` (tag `v2026.7.1-2`), path
`packages/ai/src/providers/openai-completions.ts`.

SHA-256: `58e0341a8283863b7e7443c43a246871ec9c699a176c89828523ccd3a2d12b5c`.
Source: https://github.com/openclaw/openclaw/blob/0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c/packages/ai/src/providers/openai-completions.ts

Retained to test the real patch and real adapter loop offline. Its dependencies
are mocked; this is not a full OpenClaw integration test. Upstream is MIT licensed;
see LICENSE in this directory. Update only with deliberate upstream pin review.
