# ADR 0001: Identity and Communication Boundary for OpenClaw Instances

## Status

Proposed

## Context

Each OpenClaw chief-of-staff (CoT) instance is deployed per organization
(provider or client) through the existing per-instance provisioning path.
Two related questions came up while scoping what a CoT instance needs in
order to act on an org's behalf:

1. **Identity.** A CoT needs a user/service account of its own, and
   sometimes needs to recognize or provision accounts for members of the
   org it serves. Who owns that account data — the control plane, or the
   CoT itself?
2. **Communication.** A CoT needs to talk to the humans in its own org
   (notifications, briefings, approvals), and separately, a provider's CoT
   instance needs to interact with a client's CoT instance across the org
   boundary (status, requests, approvals that span both parties).

The public baseline is workflow-neutral (see `docs/architecture.md`) and
must boot with no client-specific pipeline, connector, or vendor assumption
registered. Two anti-patterns would violate that:

- Letting the CoT self-manage identity records directly (OpenClaw "becomes
  the system" instead of managing it, contradicting the existing runtime
  boundary).
- Assuming any specific internal comm tool (Slack, Teams, email, ...) in
  the control plane or shared docs. Different orgs — our own and each
  client's — will reasonably standardize on different tools, and the
  client side is explicitly out of our control.

A further distinction surfaced during design: internal human-facing
communication (a CoT talking to its own org's people) and cross-org
agent-to-agent communication (a provider CoT talking to a client CoT) are
not the same problem. Routing the latter through whatever chat tool a
counterparty happens to use would re-multiply the identity problem per
client (a seat in every client's chosen tool) and turn structured
agent traffic into free-form chat that has to be parsed rather than a
contract that can be validated, audited, and replayed.

## Decision

1. **Identity/account records are control-plane-owned durable entities.**
   The control plane is the source of truth for which accounts exist
   (including the CoT's own service identity), their roles, and their
   provisioning status, consistent with the existing runtime boundary
   (control plane owns durable entities, state transitions, and audit
   records). Actual provisioning against a specific external system (e.g.
   inviting a user to a chat workspace) is carried out by a connector or
   worker acting on that state — never by OpenClaw managing the records
   directly.

2. **Internal, human-facing communication is a pluggable connector, not an
   assumption.** Notifications, briefings, and approval prompts to an
   org's own people go through a connector interface that OpenClaw
   operates (per the existing "OpenClaw owns user interaction... and
   notifications" boundary). The control plane and shared/public tooling
   must not hardcode or assume a specific provider. Each deployed instance
   — ours and each client's — configures the connector that fits its own
   business model. Slack is one possible connector implementation, not a
   platform assumption.

3. **Cross-org (CoT-to-CoT) communication is a dedicated agent interface,
   independent of either side's internal comm tool.** Provider-to-client
   agent traffic — requests, status, approvals that cross the org boundary
   — is handled through a structured surface (a ticket-style service or an
   MCP-exposed interface) with its contract defined in `packages/contracts`
   and ingested as durable, audited, idempotent events, the same way any
   other control-plane event is handled. This surface is intentionally
   separate from the internal comm connector in (2): a client's internal
   choice of chat tool has no bearing on how its CoT talks to ours, and
   vice versa. Humans are looped in on either side only through that side's
   own internal connector — never by granting cross-org access into an
   internal chat workspace.

## Consequences

- No chat-vendor lock-in in the public baseline; stays consistent with the
  workflow-neutral requirement.
- Cross-org agent traffic gets the same audit trail, idempotency, and
  approval-record guarantees as any other control-plane event, instead of
  being unauditable free-form chat.
- Avoids needing CoT accounts/seats in N different clients' chat tools of
  choice.
- Adds work: the ticket/MCP surface and its contract have to be designed
  and built rather than reusing an existing chat API. Provider and client
  instances need to agree on this interface, not just "join a channel."
- Deferred/out of scope for this ADR: the concrete transport for the
  cross-org surface (custom ticket API vs. MCP server vs. both) and the
  specific connector interface shape for internal comms. Both are flagged
  as follow-up design work.

## Alternatives Considered

- **CoT holds a seat directly in whatever chat tool each org uses, for
  both internal notification and cross-org messaging.** Rejected: this
  multiplies the identity-boundary problem per client, couples the control
  plane to a specific chat vendor's data model, and makes agent-to-agent
  traffic unauditable free text instead of a validated contract.
- **Standardize on one internal comm provider (e.g. Slack) as the
  supported default.** Rejected: contradicts the workflow-neutral baseline
  and excludes clients whose business model runs on a different tool.
