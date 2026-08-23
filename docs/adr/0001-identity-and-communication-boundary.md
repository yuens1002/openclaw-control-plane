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

A second instance of the same identity question surfaced when scoping
source-control access: a CoT (ours and, by the same assumption, each
downstream agency's) needs read access to specific private repositories.
The ownership question is identical to (1) — the control plane tracks the
grant, not the CoT — but source-control access adds a sharper risk: the
practical way to offer this is one provider-owned connector (e.g. a single
GitHub App) installed separately per tenant, which means one shared
credential (the connector's signing key) can mint scoped access across
every tenant's installation. A leak of that one credential has cross-tenant
blast radius, unlike a single tenant's own grant. Credential custody, not
just account bookkeeping, becomes part of the decision.

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

4. **The same rule applies to any external-system access, not just chat —
   source-control included.** Which systems a CoT can reach, and at what
   scope, is control-plane-tracked identity-record state (system, tenant,
   scope, granted/revoked timestamps), per (1). The access itself is
   provisioned per tenant at minimum necessary scope: a shared
   provider-owned connector (e.g. one GitHub App) is installed separately
   per organization — ours and each downstream agency's — with the
   specific repositories selected by that organization during its own
   installation, never hardcoded by the control plane. Because a shared
   connector's signing credential can reach every tenant's installation,
   its custody matters as much as the record-keeping: least-privilege
   permissions on the connector itself, short-lived tokens minted per use
   rather than a long-lived static secret handed to the CoT, and an audit
   trail tying each minted token back to the owning identity record.

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
  specific connector interface shape for internal comms and source-control
  access. Both are flagged as follow-up design work.
- Extending the pattern to source-control (and future) connectors makes
  credential custody a first-class concern alongside identity bookkeeping:
  a compromised shared connector credential has cross-tenant blast radius,
  so key storage/rotation and least-privilege scoping carry as much weight
  as tracking who was granted what.

## Alternatives Considered

- **CoT holds a seat directly in whatever chat tool each org uses, for
  both internal notification and cross-org messaging.** Rejected: this
  multiplies the identity-boundary problem per client, couples the control
  plane to a specific chat vendor's data model, and makes agent-to-agent
  traffic unauditable free text instead of a validated contract.
- **Standardize on one internal comm provider (e.g. Slack) as the
  supported default.** Rejected: contradicts the workflow-neutral baseline
  and excludes clients whose business model runs on a different tool.

## Status Updates

### 2026-08-18 — Decision (4), source-control: App-based connector built, then reverted as premature

Decision (4)'s App-based model — one provider-owned GitHub App installed
separately per organization, short-lived per-use tokens minted from an
App JWT, never a static secret handed to the CoT — was designed for a
multi-tenant scenario: a provider and each downstream client org each
needing their own scoped installation. A single-tenant deployment, with
no client org yet needing its own scoped installation, doesn't need that
model's full mint-and-refresh machinery to get equivalent protection —
the tradeoff only pays for itself once a genuine multi-tenant need
exists.

Given that, decision (4)'s App-based model was built
(`openclaw-control-plane` `packages/openclaw-source-control-connector`,
PR [#32](https://github.com/yuens1002/openclaw-control-plane/pull/32) —
`buildAppJwt` + `mintInstallationToken`, tested, documented, deliberately
unwired) and then **reverted**, not carried forward: building and
operating the App's mint-and-refresh pipeline (installation tokens expire
in ≤1hr, requiring a recurring refresh job with no existing scheduling
infrastructure to run it from) was disproportionate effort ahead of an
actual multi-tenant need. Which credential mechanism the agency's own
live instance runs day to day is operational detail this ADR doesn't
track — see the 2026-08-22 update below.

Decision (4)'s general principle — provider-owned App, least-privilege
per-installation scope, short-lived minted tokens, no static secret
handed to the CoT — **still stands** for a future scenario where a client
actually has its own org/repos the CoT needs scoped access to. At that
point, the reverted transport code and the research trail behind this
decision (installation vs. PAT tradeoffs; OpenClaw's own native MCP
support, confirmed live from `openclaw/openclaw` source, not assumed)
are the starting point, not a from-scratch investigation — see
[`openClaw-CoT-agency-profile#6`](https://github.com/dev-yuen-agency/openclaw-cot-agency-profile/issues/6)
for the full writeup. It's also plausible OpenClaw ships native GitHub
App support upstream before that scenario ever arises, which would
obsolete this control-plane package entirely rather than just revive it.

### 2026-08-22 — Decision (4), source-control: this ADR doesn't track which mechanism any tenant currently runs

The entry above named which credential mechanism this agency's live CoT
instance used at the time. That was a scope mistake for an architecture
doc: this ADR records the general pattern, not any tenant's current
operational state, which changes independently of the architecture and
belongs in each tenant's own private profile repo, not here.

For the record, going forward: GitHub access for a CoT can be provisioned
either way under decision (4)'s general principle — a PAT (simpler,
adequate for a single low-risk credential) or a GitHub App installation
(least-privilege, short-lived minted tokens, appropriate once a genuine
multi-tenant need exists). Which one any given tenant runs, and why, is
operational detail this ADR does not track.
