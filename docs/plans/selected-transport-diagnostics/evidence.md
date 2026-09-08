# Selected transport evidence

2026-09-08. Source revision: `0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c`.
Read-only deployment-owner evidence inspection; no new model call or live write.

## Observations

- Retained trace explicitly selected `boundary-aware:openai-completions`.
- Provider generation lookup for the already captured response returned HTTP 404
  again. No provider usage or routing result can be inferred from that lookup.
- Trace model metadata names provider/API and thinking-level fields but does not
  contain the final request token limits. The captured context lists 65 tools and
  zero messages; that is a trace representation, not a measured final wire payload.
- Final output from the prior canary was empty and length. Usage fields were zero
  in the session record. The transport initializes those values to zero.

## Source path and budget derivation

`resolveEmbeddedAgentStreamFn` selects `createBoundaryAwareStreamFnForModel` for
the supported API/default stream or resolved runtime credentials. Its factory
selects `createOpenAICompletionsTransportStreamFn`, which builds the request and
calls the real SDK before `processOpenAICompletionsStream` consumes its chunks.
The previous SDK adapter patch is not on this selected path.

The request builder resolves maxTokens from options, then model.params, then
model.maxTokens. Depending on compatibility, it clamps explicit options to model
limits and proxy-like endpoints to estimated remaining context. It selects the
appropriate outgoing max-token field. Payload hooks can subsequently replace the
request, followed by further payload checks/transforms before the SDK call.
Therefore neither a config default nor the trace's message count establishes the
historical outgoing budget. The original final limit remains unknown; do not
claim current configuration reconstructs a past request exactly.

The selected processor maps decoded finish reasons, can suppress reasoning and
filters tool blocks when termination is not executable toolUse. These mechanisms
can produce empty final content but do not establish which occurred in the canary.
The next observation points must precede those losses and follow request shaping.

## Decision

Proceed with a network-only synthetic reproduction through the real resolver and
selected transport. No token cap, model route or tool-safety change is justified
by this evidence. Production identifiers and raw trace content remain in the
deployment owner's restricted operational record.
