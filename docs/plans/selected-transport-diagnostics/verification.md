# Selected transport verification

Candidate source: `c1a180d2d955a2e5e38dfb41980fe1ba81bc64fd`.
Base: `4ef71175caf9366ef3b8dd74f93b51be370a2e1e`.
Date: 2026-09-08. Root and independent final-artifact execution passed.

## Reproduction and mock boundary

The original image, containing only the SDK adapter patch, passed the synthetic
baseline in `--expect-uninstrumented` mode. Ordinary mode failed the visible
scenario with `selected resolver must reach diagnostic exactly once: 0 !== 1`.
This demonstrates the prior instrumentation miss, not the production empty-turn
cause. Baseline covered the initial 13 scenarios before structured content was added.

The patched core bundle passes 14 scenarios: 12 enabled/disabled pairs, plus
non-target provider and throwing sink. The harness imports the shipped resolver
export and preserves its real factory, processor and SDK. A loopback HTTP server
supplies synthetic SSE; Docker `--network none` prevents external calls. No
factory/resolver mocks, copied execution functions or provider credentials are used.

The payload hook changes the outgoing limit from 100 to 37. Both the received
HTTP payload and diagnostic must contain 37. Each paired scenario asserts exactly
one request, identical request payloads, event-type ordering and final output
(except the timestamp). This does not assert equivalence of every event payload,
all provider retries, every transport mode or arbitrary upstream streams.

The mutation check copies the built distribution beside itself in a disposable
container, removes only the selected collector constructor, and runs the ordinary
harness. It requires exit 1 and the exact diagnostic-count assertion with `0 !== 1`;
a timeout, import failure or unrelated crash is not accepted as mutation evidence.

## Repository checks and independent inspection

- Gate 1: five deliverables, eight ACs, zero orphans.
- `npm run precheck`: 402 tests across 29 files, no skips; typecheck and build pass.
- Eight focused unit/patch tests cover bounded metadata, usage presence,
  throwing sink, independent helper typecheck, complete source hash, anchors,
  CLI installation and reapplication refusal.
- Previous suite count was 411. Nine mocked-adapter cases were replaced by the
  standalone real-path suite; the 14 scenarios are additional to the 402 count.
- Independent verifier `transport_ac_verify` inspected call placement, mock
  boundaries, exact mutation failure, hash/watch integration and handoff, and
  independently ran the full precheck. No blocking source finding was identified.
  It also independently ran both final-image scripts against the immutable latest
  image ID below, exit 0. Main-thread QC accepted this evidence; no blocker remains
  in the implementation ACs. OCR and holistic review are recorded separately.

## Final runtime artifact

Full `docker build -t openclaw-selected-transport-check .` passed, including frozen
dependency installation, upstream build, UI build and final runtime assembly.
Registry download retries recovered without changing the lockfile. A cached full
build from the committed candidate also passed with the same runtime manifest:
`sha256:7c362806761abd0580ae5b3b710f9981fbb5a34a375b1ccbafd28e3a8fa35a8d`.
The latest local image index (including regenerated build attestation) is
`sha256:9bc2bdb21a4ff0a01c7206f4e999cc99544bd4d7fe46915d2487a159e58a3748`.

Root executed both scripts in the assembled final image with external networking
disabled: all 14 cases and the targeted mutation passed, exit 0. The actual
resolver bundle was `attempt.model-diagnostic-events-BxlQ7dAi.js`. Reproduce with
the commands in [the operations guide](../../openai-stream-diagnostics.md#build-and-source-upgrades).
The initial image index changed on the cached build because its attestation was
regenerated; the runtime manifest and configuration digest did not change.

No production deployment, environment change, trigger or model call ran as part
of these checks. Historical provider lookup returned 404; see [evidence.md](evidence.md).
