# Vending Worker Example

The vending worker is an example vertical slice. It is not installed by the
shell OpenClaw/Railway onboarding path and is not a default production workflow.
M1 supports only fake/manual lead ingestion and call transcript ingestion.

## Current Behaviors

- Validate a vending location lead with `VendingLeadSchema`.
- Validate a call transcript with `VendingCallTranscriptSchema`.
- Produce an approval-gated placeholder follow-up draft from a transcript.

The example worker keeps its schemas local to `workers/vending`. It does not add
baseline database tables, seed rows, connectors, or installed pipeline state.
