# OpenAI-compatible stream diagnostics

The root image includes an optional metadata collector around the pinned
OpenClaw application-owned completions transport selected by
`boundary-aware:openai-completions`. Set
`OPENCLAW_STREAM_METADATA_DIAGNOSTICS=1` in the gateway process environment
to enable it for the `openrouter` provider. Every other value is disabled.
Installing the patch alone does not enable logging.

Each attempt emits at most one JSON stderr line with event
`openai_stream_metadata`. It records final request model/token limits,
message/tool counts, stream usage-request flag, SDK chunk counts, bounded
response/model identifiers, primary-choice finish reason and usage metadata,
content-field character counts, and normalized block counts before and after
the transport's final filtering. Schema version 2 also records the selected
reasoning-emission boolean and content-array entry counts. Missing usage is null,
not zero. Counters are
saturated at the maximum safe integer; record size does not grow with stream
length. Strings outside the identifier format/length are omitted. Unrecognized
finish reasons are reported as `other`.

The collector observes **SDK-decoded chunks**, not raw network bytes. Character
counts are JavaScript string lengths, not token counts. Tool-entry counts are
deltas, not unique completed calls. Reasoning-field counts sum the named fields
and may count mirrored fields twice; they measure field presence, not unique
reasoning output. Only the first choice is inspected, matching this adapter.
Model identifiers are provider-reported metadata, not independently verified
routing. No additional model request or stream reader is created.

String-length counters do not measure structured content arrays. The array-entry
counters expose their presence without inspecting or persisting their contents.
Do not interpret zero string counts alone as proof of an empty decoded response.

The record contains no prompt, generated/reasoning text, tool names/arguments,
headers, raw error bodies or credentials. Metadata is operationally sensitive:
use existing restricted log access and retention. This is not a general payload
debugger. Do not enable broader payload logging as part of this procedure.

## Reading a result

- `deltaToolEntries > 0`, `beforeNormalization.toolCall > 0`, and
  `final.toolCall = 0` on length establishes that the adapter removed parsed
  tool blocks. It does not establish why the provider stopped early.
- Zero visible counters with positive reasoning counters indicates reasoning
  fields arrived even if they were not emitted as normalized thinking blocks.
- Null usage means the observed source did not supply usable counters.
  `chunkUsageSeen` and `choiceUsageSeen` distinguish absent containers from
  malformed or empty reported containers.
- An error before the first chunk can have no response ID. Use `startedAt`
  and surrounding transport/run logs, accounting for concurrency; do not
  invent a run correlation from proximity alone.
- `beforeNormalization` can be null on an exception before that stage.
  `final` describes the adapter's result, not the later agent-run outcome.

## Build and source upgrades

`scripts/patch-openai-stream-metadata.mjs` checks the complete upstream
`src/agents/openai-transport-stream.ts` source
SHA-256 before writing and refuses an existing companion. This intentionally
blocks builds on a source change, including alternate `OPENCLAW_GIT_REF`
versions, until reviewed. The frozen dependency lock and upstream model
defaults remain unchanged. Fast tests retain the exact upstream file for hash,
anchor and CLI checks; the companion is separately typechecked. The execution
test uses the real bundled resolver, factory and transport with a local synthetic
SSE server and external networking disabled. It does not replace the factory.
Run it against the final Docker image before deployment; bundle-marker checks
alone do not establish execution-path coverage.

From the repository root, build the final runtime image and run both checks
against it (the mount exposes only the local test scripts):

```sh
docker build -t openclaw-selected-transport-check .
docker run --rm --network none --mount type=bind,source="$(pwd)/scripts",target=/checks,readonly --entrypoint sh openclaw-selected-transport-check -c 'node /checks/test-selected-transport.mjs /openclaw/dist && node /checks/test-selected-transport-mutation.mjs /openclaw/dist'
```

The example uses a POSIX shell; in PowerShell use `${PWD}/scripts` for the
mount source. The first check executes 14 resolver scenarios plus a setup-failure
cleanup case (15 total). The second removes only the selected collector in a
disposable copy and requires the diagnostic-reachability assertion to fail. Neither check calls
an external provider. These checks complement `npm run precheck`; they are not
included in that command and must be recorded separately.

The earlier SDK adapter integration is removed from new builds. That adapter was
bypassed by the observed embedded-agent path; keeping its patch would add another
source-upgrade constraint without covering this incident. Historical verification
records describe the earlier, narrower SDK tests as performed at the time.

The patch and collector Docker COPY inputs are in the canary watch reference. That file is
not applied automatically by Railway. Operators must reconcile the live native
watch list explicitly before relying on helper-only commits to trigger builds.
The Dockerfile change itself remains a watched build input.

## Rollout and rollback

Follow [live-instance operations](live-instance-operations.md#5-prod-state-change-procedure).
This document is a procedure, not approval to mutate a live deployment.

1. Name the exact project/environment/service and source revision in the private
   operational record. Read current source/deployment, gateway flag and watch
   list, and record the expected old values. Preserve unrelated staged changes.
2. Obtain approval for the exact deployment and flag change. Deployment/restart
   affects all callers sharing the gateway, including interactive sessions and
   scheduled work. Use existing tested deployment/readiness paths where available;
   never treat a bulk staged apply as a scoped diagnostic change.
3. Deploy the reviewed revision through the normal release flow with diagnostics
   disabled first. Observe deployment success, authenticated serving readiness,
   source/patch readback and the absence of diagnostic records on an observed
   default-off attempt. A health response alone does not establish deployed bytes.
4. Enable the flag only for a bounded approved diagnostic window, with explicit
   deployment expectations: a variable write may rebuild the image. Read back the
   running process environment. Correlate one approved canary using response IDs
   and terminal run evidence. No automatic retries. Any comparison request needs
   its own explicit scope; existing naturally occurring traffic may be inspected.
   Shared process scope means other
   OpenRouter completions during the window also emit metadata.
5. Disable by restoring the exact prior flag state (unset versus an existing
   value matters). Check whether deletion created a deployment; if not, explicitly
   apply the approved redeployment. Verify the running process and authenticated
   readiness before declaring cleanup complete. This stops new
   records, not retention of existing logs. If the patch affects behavior, restore
   the previously recorded image/source revision through the approved rollback
   procedure and verify authenticated readiness again.

No deployment, environment write, restart, or test traffic is performed by the
repository test suite. Diagnostics supply evidence for a subsequent fix; they
do not restore a feature or validate its external recording/governance contract.
