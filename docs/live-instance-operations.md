# Live-Instance Operations

Governs how anyone — this repo's library code, a human at a terminal, or
an agent working mid-session — reads or writes state on an
already-provisioned ("live") instance.

This is an operations doc, not an ADR: it accrues rows and rules as new
live-touching surfaces appear, rather than recording one point-in-time
decision (see [docs/README.md](README.md)'s Document Types).

It exists because two ungoverned live operations happened during an
unrelated bug fix. Section 6 walks both through the table. The rest of
the document is written to be usable without knowing about them.

## 1. Scope and Non-Goals

**In scope.** Any operation against an instance that is already
provisioned and in use — reading its configuration, writing its
configuration, reading or writing the Railway variables behind it,
restarting or redeploying it, or deploying code to it. The rules apply
uniformly to three kinds of operator:

- Library code in this repo (`packages/**`, `deploy/**`).
- A human running a CLI or HTTP client at a terminal.
- An agent proposing or running a command inside a session.

The operator's identity changes nothing. A rule that a library function
must follow is a rule a human must follow by hand, and vice versa.

**Not in scope: initial provisioning.** Standing up a *new* instance is
governed by the provisioning path's own tested code
(`packages/openclaw-railway-installer/src/provision-client.ts`), which
already establishes the target's identity by diffing service IDs
before and after creation (inside `provisionClientInstance`), refuses
to proceed when more than one candidate matches (`selectSoleService`),
and reads back credentials rather than regenerating them on a rerun
(`provisionClientInstance`'s `reusedExistingService` branch). Those are
safe idempotent patterns on a target that has no live state to damage
yet. Nothing here loosens or replaces them.

**Also not in scope.** Application-level correctness of what is
configured, upstream wrapper behavior, and CI/CD for this repo's own
code. This document is about the act of touching a live target, not
about what the target should be configured to do.

## 2. Two-Axis Classification

Every operation gets **two** independent classifications: a mutation
tier and a credential exposure. Neither one determines the other, and
an operation that is benign on one axis can be forbidden on the other.

### 2.1 Decision procedure

Run these four questions in order, before consulting the table.

1. **What am I targeting, and is it live or shared?** Name the target
   explicitly. If the command can fall back to an implicitly linked
   target when the name is omitted, it is unscoped and must be
   rejected — this is exactly what `checkGuard`'s `hasServiceFlag`
   check in `packages/openclaw-railway-installer/src/guard-cli.ts`
   enforces for direct CLI use.
2. **Which mutation tier?** Walk §2.2 from the bottom up and take the
   *highest* tier that applies. An operation that writes and also
   restarts is restart-triggering, not idempotent-write.
3. **Does a secret enter the command, or come back out of it?** Answer
   both halves separately (§2.3).
4. **Does tested library code already cover this operation?** If yes,
   ad hoc use is not permitted — use the library path (§4).

### 2.2 Mutation axis

| Tier | Definition |
| --- | --- |
| **read** | Retrieves state. Changes nothing on the target. |
| **idempotent-write** | May change state, but compares current state first and skips the write when already at the target value. Repeating it is a no-op. |
| **unconditional-write** | Writes every time it is called, regardless of current state. Repeating it repeats the effect. |
| **restart-or-redeploy-triggering** | A write whose side effect is that the running process restarts or the service redeploys. Causes real downtime on a live target *even when the written value is unchanged*. |
| **destructive** | Removes state that cannot be reconstructed from the operation's own inputs. |
| **deploy** | Replaces the code or image running on the target from a source outside the PR-merge flow. |

**Why `deploy` is its own tier and not just "a big write."** Deploys
here are one-shot snapshot uploads from whatever is on the operator's
local disk, not continuously tracked from a branch — see the
one-shot-snapshot note in `provision-client.ts`'s module header and
the `railway up` call inside `provisionClientInstance` that it
describes. A deploy therefore bypasses PR review, branch protection, and
this repo's merge flow **by design**, and no permission prompt or code
gate currently stands in front of it. Treating it as an ordinary write
misses the thing that makes it dangerous: what ships is not what was
reviewed.

### 2.3 Credential axis

Two independent questions, both answered per operation:

- **Returns a secret?** The operation's output — stdout, a response
  body, a log line — contains a secret value.
- **Requires a secret?** A secret must be supplied as input for the
  operation to work at all.

An operation can be both, either, or neither. "Neither" is the only
answer that removes the credential axis from consideration.

### 2.4 The absolute credential veto

> **A secret placed in a command's argument string is forbidden at
> every mutation tier, including `read`.**

This overrides the mutation axis entirely. It is not weighed against
the tier, traded off, or excused because the operation is otherwise
harmless. An argument string reaches shell history, process listings,
terminal scrollback, screen shares, and session transcripts; a `read`
that leaks a live credential into all five is worse than a write that
leaks nothing. See §3 for the permitted paths.

### 2.5 Combined rules

Each row is a meaningful cell of the two axes. "Exemplar" means an
in-repo path that already does this correctly; "counter-example" means
an in-repo path that does not.

| Mutation tier | Credential | Rule | In-repo reference |
| --- | --- | --- | --- |
| read | neither | Allowed ad hoc. Declare the target (§4) and proceed. | Exemplar: `packages/openclaw-setup-applier/src/apply-profile.ts`'s `waitForHealthy` polls `/setup/healthz`, which `packages/openclaw-railway-installer/src/index.ts` documents as unauthenticated — it sends no credential and returns none. Note the near miss: `setup-api-client.ts`'s `getStatus()` looks like this row but is **not** — every `/setup/api/*` route requires Basic auth, so it belongs to the `requires a secret` row below. Reads are not credential-free by default; check which endpoint is actually being called. |
| read | **returns** a secret | Allowed only with an explicit acknowledgement that the output will contain secrets, and only when scoped to a named target. Never pipe the output into a log, a file, or a transcript. | Exemplar: `guard-cli.ts`'s `checkGuard` requires `--i-know-this-prints-secrets` before a variable listing runs, and never spawns the underlying CLI when the check fails. Counter-example: `packages/openclaw-railway-installer/src/railway-variables.ts`'s `listRailwayVariables`/`readRailwayVariable` reach the same CLI programmatically without that gate (gap G4, §7). |
| read | **requires** a secret | Allowed **only** if the secret reaches the process by stdin or environment. Forbidden if it is interpolated into the argument string — §2.4, no exceptions. | Exemplar: `setup-api-client.ts`'s `createSetupApiClient` builds the auth header inside the process from a value never placed on a command line. Counter-example: the Manual Install block in `deploy/openclaw-railway/README.md` passes `SETUP_PASSWORD` as an inline `-v "NAME=VALUE"` argument. |
| idempotent-write | any | Allowed through tested library code. Requires **both** halves: compare-then-write *and* post-write verification (§5). Ad hoc use is not permitted where a library path exists. | Exemplar (both halves): `packages/openclaw-setup-applier/src/apply-profile.ts`'s `applyProfile` skips the mutating call when its opening `getStatus()` already reports configured, then re-reads status after the write and throws if it did not take. Second exemplar: `patch-allowed-origins.ts`'s `patchAllowedOrigins` compares before writing, skipping the POST (and therefore a live gateway restart) when the origin is already present, then re-reads the config and throws if the origin is absent after the write reported success. |
| unconditional-write | any | Not permitted ad hoc. In library code, requires an explicit stated reason why a pre-read comparison is impossible, plus post-write verification. Otherwise it must be converted to idempotent-write. | Exemplar: `provision-client.ts`'s `updateClientTemplateRef` and `updateClientOpenClawRef` were converted to exactly this shape -- they read the current ref, no-op when it already matches, refuse when it is not what the caller said to expect, and wait on auth-gated readiness after the redeploy (gap G1, §7). Counter-example: `import-workspace-files.ts`'s `importWorkspaceFiles` POSTs without a pre-read comparison (gap G3, §7). Note on `importWorkspaceFiles`: the missing pre-read is why it appears here, but its **effective tier is the row below** — `docs/plans/workspace-identity-transport/ACs.md`'s AC-XPORT-003 states that calling the import endpoint stops the gateway as a side effect. That statement is second-hand in this repo: it is asserted in the AC's premise and is the stated reason the module never retries, but the independent upstream re-confirmation recorded in that plan attaches to AC-XPORT-005 (response shape), not to the gateway stop. Classified at the higher tier because over-classifying under unresolved provenance is the safe direction; the module's own marker carries the same word. |
| restart-or-redeploy-triggering | any | Never ad hoc. Requires an explicit confirmation naming the target, and a post-change readiness check against the live target — not merely a "the write succeeded" result. | Exemplar: `railway-variables.ts`'s `WriteRailwayVariableOptions.skipDeploys` defaults to `--skip-deploys` and makes triggering a redeploy an opt-in the caller states deliberately. `applyProfile`'s `waitForHealthy` call waits for the instance to come back healthy after a redeploy-triggering write. Writing the raw-config endpoint belongs in this tier, not in plain-write: per `docs/plans/post-deploy-readiness/plan.md`'s Item 4 (recorded from the upstream wrapper's source, second-hand in this repo), a POST there restarts the gateway whenever the instance is already configured — which is why `patchAllowedOrigins` compares first and skips. |
| destructive | any | **Forbidden.** Not gated, not confirmed — not available. A destructive capability with no caller should be deleted rather than fenced. | Worked example: `setup-api-client.ts` used to expose a `reset()` wrapping the setup API's config-delete endpoint, with zero production callers and no gate. It was deleted rather than fenced (gap G2, §7). The endpoint still exists on the instance; this repo no longer offers a way to reach it. |
| deploy | any | **Forbidden ad hoc.** A deploy to a live target requires the full prod-state change procedure (§5): a written proposal, human approval naming the target, and post-deploy verification. Local working-tree state must never be the source. | `provisionClientInstance`'s `railway up` call performs the one-shot snapshot upload its module header describes. Nothing currently gates it (gap G9, §7 — this document is that gate). |

### 2.6 Why one axis is insufficient

A single read → write → destructive scale would have classified the
incident's second operation (§6) as a **read**, the most benign value
on the scale, and cleared it. It *was* a read: a GET, changing nothing.
It was dangerous for a reason the mutation scale cannot express — a
live credential was interpolated into the argument string of the
command that performed it.

The reverse also holds. An unconditional-write that needs no credential
at all is a real risk to a live target and would be under-weighted by a
credential-only rule.

The two axes are therefore assigned independently, and the stricter of
the two verdicts wins. The credential veto in §2.4 is absolute
precisely so that a benign mutation tier can never launder a credential
exposure.

## 3. Credential-Flow Rule

Three rules. Each already has a working in-repo implementation; none of
this is a new mechanism.

**3.1 Secrets reach a command by stdin or environment, never by an
argument string.**
`packages/openclaw-railway-installer/src/railway-variables.ts`'s
`writeRailwayVariable` writes a variable by piping the value through
`--stdin` and keeping it out of `args` entirely, so it never lands in a
process listing or shell history. For HTTP, the equivalent is building
the credential into a header inside the process, as
`packages/openclaw-setup-applier/src/setup-api-client.ts` does — not
shelling out to an HTTP client with the credential in its argv. This
rule has no exception for reads (§2.4).

**3.2 One named variable per write. Never bulk.**
`writeRailwayVariable` takes a single `name`/`value`/`service` triple
(`railway-variables.ts`). A bulk write cannot be reviewed — neither the
operator nor a reviewer can state precisely what changed — and it makes
the blast radius of a mistake the whole variable set rather than one
key. Provisioning writes six variables by looping over named entries
one call at a time (`provisionClientInstance`), rather than by one
combined call.

**3.3 Refuse rather than guess under ambiguity.**
`packages/openclaw-railway-installer/src/approve-own-device.ts`'s
`approveOwnDevicePairing` returns without acting when there is nothing
pending, and **throws** rather than picking one when more than one
candidate is pending — guessing would risk approving someone else's
device.
`provision-client.ts`'s `selectSoleService` applies the same rule to
service selection. When an operator cannot name exactly which object an
operation will affect, the operation does not run.

**3.4 Never reproduce a credential value in writing.** Refer to
credentials by variable name (`SETUP_PASSWORD`,
`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_INSTANCE_SETUP_PASSWORD`) in docs,
issues, PR bodies, commit messages, and session transcripts. This
document contains no credential value, including in §6.

For the wider question of who holds a credential and at what scope, see
[docs/adr/0001-identity-and-communication-boundary.md](adr/0001-identity-and-communication-boundary.md),
which owns credential-custody framing. This section governs only how a
credential moves into a command; that ADR governs whether the operator
should hold it at all.

## 4. Pre-Flight Declaration

Before running **any** ad hoc command against a live instance, the
operator — human or agent, no distinction — states the following, in
writing, *before* the command runs:

1. **Target.** The specific target, named explicitly, and whether it is
   live or shared. "Whatever is currently linked" is not a target.
2. **Tier on both axes.** The mutation tier from §2.2 and both
   credential answers from §2.3.
3. **What will be read first, and what is expected.** For anything
   above `read`, the state that will be read before writing, and the
   value the operator expects to find. A surprise here aborts the
   operation.
4. **Credential path.** Whether a secret enters the command, and if so,
   by which mechanism from §3.1 — and therefore how argument-line
   exposure is avoided.
5. **Reversibility and restart risk.** How the change is undone, and
   whether a restart or redeploy will fire. Note that a redeploy can
   fire even when the written value is unchanged (§2.2).
6. **Whether tested library code already covers this.** If a library
   path exists for the operation, **ad hoc use is not permitted** —
   use the library path. This generalizes the narrow rule already
   stated in
   [docs/setup-profile-applier.md](setup-profile-applier.md#do-not-call-the-mutating-setup-endpoints-yourself)
   from the mutating setup endpoints to the whole live surface.

A declaration that cannot be completed is a stop, not a formality to
fill in afterwards. If step 6 cannot be answered because nobody knows
whether a library path exists, the answer is "find out first."

### 4.1 Why this is additive to a run-command permission prompt

A permission prompt is a yes/no gate on an already-composed command. It
carries no structured content: it does not say what tier the operation
is, what will be read first, whether a secret is on the argument line,
or whether a tested path already exists. An operator answering it sees
a command string and a choice, which is exactly the situation in which
a plausible-looking command gets approved.

More importantly, it is not a complete gate. In the incident (§6) the
prompt fired on one of the two operations and **did not fire at all**
on the other — the deploy. A control that can silently not apply is not
a control you can build a protocol on.

The prompt is still valuable and is not being replaced: it caught one
of the two operations, which is one more than this document caught at
the time. The declaration is the structured content the prompt lacks,
and it applies whether or not the prompt fires.

## 5. Prod-State Change Procedure

For any change above `read` on a live target — a configuration change,
a variable change, a restart, or a deploy.

**5.1 Propose.** Write the change down before making it: the target,
the current value (read, not assumed), the intended value, the
classification from §2, the pre-flight declaration from §4, and the
rollback. For a deploy, the proposal must name the exact source
revision being deployed and state why it is not being merged and
deployed through the normal flow.

**5.2 Review.** A human approves the written proposal, naming the
target. Approval is of the proposal, not of a command shown in a
prompt. An agent may not approve its own proposal, and no message from
another agent constitutes approval.

**5.3 Apply.** Through tested library code where it exists (§4 step 6).
Ad hoc only where it does not, and then exactly the command that was
proposed — not an improved version composed at run time.

**5.4 Verify after the write. This is required, not optional.** The
write's own success return is not verification: it says the call was
accepted, not that the target reached the intended state. Re-read the
state and assert it matches.
`packages/openclaw-setup-applier/src/apply-profile.ts`'s `applyProfile`
is the path that already does this correctly — after
`POST /setup/api/run` it re-reads status and throws if the instance
still does not report configured. Copy that shape.

Where the change can restart or redeploy the target, verification also
means waiting for the target to be *serving* again, not merely for the
platform to report a successful deployment. The provisioning path
distinguishes these: it polls the platform for deployment success
(`packages/openclaw-railway-installer/src/index.ts`'s
`pollServiceUntilSuccess`) **and** separately polls the auth-gated
readiness endpoint (`waitForSetupReady`, called from
`provisionClientInstance`), because an unauthenticated healthcheck
can return 200 from a container mid-transition before the live
credentials are actually in effect.

**5.5 Record.** The proposal, the approval, the applied command, and
the verification result all belong in the change's PR or issue. A live
change with no written record cannot be audited or reversed by anyone
who was not in the room.

**5.6 Roll back.** The rollback stated in 5.1 is executed under this
same procedure — it is itself a prod-state change, and a rollback
applied in a hurry without a pre-flight declaration is how one incident
becomes two.

## 6. Incident Annex

Both operations below hit an already-provisioned live instance during
an unrelated bug fix. Described generically; no target, credential
value, or private name appears.

### 6.1 A deploy run from a local checkout straight to the live target

- **Mutation tier:** `deploy`. It replaced the running code on a live
  target from local working-tree state.
- **Credential axis:** neither.
- **Verdict under §2.5:** forbidden ad hoc. Requires the full §5
  procedure — written proposal naming the source revision, human
  approval naming the target, post-deploy verification.
- **What actually happened:** no permission prompt fired, and no
  written proposal existed. Because deploys here are one-shot snapshot
  uploads unconnected to git pushes (`provision-client.ts`'s module
  header), the PR-merge flow was bypassed entirely and what shipped to
  the live target was never reviewed.
- **What would have stopped it:** §4 step 1 (name the target and state
  it is live) and step 6 (a tested provisioning path already covers
  deploying to this target), then §5.2 (a human approves a written
  proposal). Any one of the three is sufficient.

### 6.2 A read of the raw-config endpoint, credential on the argv

- **Shape:** a GET against the instance's raw-config endpoint, with the
  live setup password read out of Railway variables and interpolated
  into the argument string of a command-line HTTP client. No runnable
  form is reproduced here.
- **Mutation tier:** `read`. Benign. It changed nothing.
- **Credential axis:** **requires** a secret as input — and supplied it
  on the argument line. It also **returned** the target's full raw
  configuration.
- **Verdict under §2.4:** forbidden, on the credential axis alone,
  independent of the mutation tier. The veto applies at every tier
  including `read`. Reading §2.5's `read` / *requires a secret* row
  reaches the same answer: permitted only via stdin or environment.
- **The correction is not "don't read."** It is that the credential
  must reach the process the way `setup-api-client.ts` does it —
  built into a header inside the process — rather than through argv.
  The read itself was reasonable.
- **What actually happened:** a permission prompt blocked this one.
  That is the prompt working, and is why §4.1 keeps it. It is not a
  substitute for the classification: the prompt gave a yes/no on a
  command string, with no statement of tier, credential path, or
  whether a library path already existed.

The pairing is the point. One axis would have cleared 6.2 as a read;
the other would have under-weighted 6.1 as credential-free. Only the
two together catch both.

## 7. Gap Register and Disposition

Every gap found by the research pass behind this document, dispositioned
exactly once. See
[docs/plans/live-instance-operations/plan.md](plans/live-instance-operations/plan.md)
for the plan these dispositions came from.

### In scope — closed by this document

| Gap | Disposition |
| --- | --- |
| **G9** — nothing governs ad hoc CLI or HTTP use against a live instance during an interactive session. This is the gap the incident exposed. | Closed by §3, §4, and §5. The pre-flight declaration and the prod-state change procedure apply to every operator, including an agent mid-session. |
| **G7** — no canonical marker distinguishes read-only, idempotent-write, unconditional-write, and destructive code paths. | The tier vocabulary in §2.2 is the canonical one; this document is where it is defined. Applying tier-marker headers to the individual live-touching modules is a separate deliverable in the same plan; this document owns the vocabulary, not the markers. |

### Escalated

| Gap | Disposition |
| --- | --- |
| **G2 — CLOSED.** The setup API client exposed a destructive config-reset call that deletes the target's configuration file outright (`setup-api-client.ts`'s `reset()`), with zero production callers and no gate. | Classified **Forbidden** in §2.5, then **deleted** rather than gated — unused destructive code is safer removed than fenced. Filed as issue #36 and resolved; the method and its tests are gone, and the applier doc no longer implies the method is available. Rationale retained at `docs/plans/live-instance-operations/draft-issue-config-reset.md`. |

### Named follow-ups, with the recommended fix — not built here

**G5 — post-write verification: CLOSED. Concurrency control: still
open.** The verification half was this document's first recommended
follow-up, because §2.5's idempotent-write rule requires *both*
compare-then-write and post-write verification while
`packages/openclaw-railway-installer/src/patch-allowed-origins.ts`
had only the first — the protocol documented a rule its own most-cited
example did not satisfy. That half is now fixed: the function re-reads
the raw config after the POST and throws if the origin is absent,
mirroring `applyProfile`'s post-run status re-read. No wait precedes
that read, deliberately — `/setup/api/config/raw` is served by the
wrapper from the config file and never proxied to the gateway, so the
POST's gateway restart does not gate it.

*Still open:* concurrency control. The read-modify-write window between
the GET and the POST means a concurrent write to the same config is
silently lost, last-write-wins over the whole document. *Recommended
fix:* compare the document read during verification against what was
written, and fail loudly on divergence rather than assuming this
process was the only writer.

**G1 — CLOSED.** The client-ref update functions performed an
unconditional variable write with a hardcoded auto-confirmed redeploy,
and afterwards checked only platform deployment success, not whether the
instance actually served authenticated requests.

Closed by converting both `provision-client.ts` update paths to
compare-and-swap. They read the current ref first and return a no-op
without redeploying when it already matches -- a redeploy is live
downtime, so a same-value call must not buy one. They require the caller
to state the ref it believes is currently set and refuse on mismatch,
which is the confirmation this tier requires: the operator has to know
what they are replacing.

That check is **not** an atomic compare-and-swap, and this entry does not
claim concurrency safety. The read and the write are separate calls, so
two invocations can both read the same value, both pass the check, and
both write -- last one wins. What it reliably catches is drift that
already existed at read time, which is the common case. Genuine
serialization would need a provider-side conditional write (the Railway
CLI exposes none) or a lock shared by every writer; that remains open,
alongside the same unresolved concurrency question on the CORS patch in
G5. And they now wait on the
auth-gated `/setup/api/status` after the redeploy -- the same signal the
provisioning path uses -- because a container can report a finished
deployment while not yet answering authenticated requests. That last part
matters most for the application-version bump, which changes what the
instance actually runs.

The redeploy still passes its auto-confirm flag, deliberately:
confirmation now happens at the function boundary via the expected-ref
argument, so a second interactive prompt would only break
non-interactive callers without adding a real check. This closes the
*write* half only -- the service-scoping invariant remains prose (G6).

**G3 — the workspace-file-import function does an unconditional POST
with no pre-read comparison.** `import-workspace-files.ts`'s
`importWorkspaceFiles` POSTs the archive every call. Per the upstream
note in that module's header (second-hand in this repo, recorded from
the upstream wrapper's source rather than verified here, and not
re-confirmed against that source by this document), the server side
extracts into the data directory
without deleting existing files first, so the operation overwrites
per-file rather than wiping — but nothing compares before writing.
Currently unwired from both provisioning paths, though built and
exported. *Recommended fix:* add a pre-read comparison before this is
ever wired into a provisioning path. Low urgency while it has no
production callers; not low urgency the day it gains one.

**G4 — programmatic Railway variable calls bypass the human-CLI
guard.** `guard-cli.ts` enforces explicit service scoping and a
secret-echo acknowledgement, but only for direct human invocation:
`checkGuard` is imported nowhere outside `guard-cli.ts` itself and its
test. `railway-variables.ts`'s `listRailwayVariables` and
`writeRailwayVariable` call the underlying runner directly, with
neither protection. *Recommended fix:* move the check to the
process-spawn boundary so every path — human and
programmatic — passes through it. This is a real refactor of where the
spawn happens, not a doc change, which is why it is a follow-up rather
than in scope here.

**G6 — the "never touches another service" invariant is prose, not
code-enforced.** The doc comments on `provision-client.ts`'s
`updateClientTemplateRef` and `updateClientOpenClawRef` state it; the
only actual enforcement is that `service` is a required parameter that
reaches the CLI as an explicit `--service` flag. Nothing asserts at run
time that the named service is the intended one. (Related, and
deliberately not opened as its own gap: `provisionClientInstance` runs
a volume-attach command unscoped, but that is initial provisioning,
outside §1's scope.) *Recommended fix:* a runtime assertion that the
resolved target matches the caller-declared target before any mutating
call. Future work.

### Explicitly excluded — no follow-up

**G8 — a Railway-CLI test fixture is duplicated.** A shared fixture
exists at `tests/fixtures/fake-railway-runner.ts`, and several test
files separately declare their own local class of the same name with a
different constructor shape. This is test hygiene, unrelated to
live-instance safety: no live target is reachable from a test fixture.
Recorded here only so it is not mistaken for an oversight.

## 8. Decision and Alternatives Considered

**Decision.** Classify every live-instance operation on two independent
axes; make the argument-line credential prohibition an absolute veto
that overrides the mutation tier; require a written pre-flight
declaration before any ad hoc command against a live target; and
require post-write verification on every change above `read`.

**Rejected: rely on the run-command permission prompt alone.** The
prompt already exists and already caught one of the incident's two
operations, so this is not a hypothetical alternative — it is the
status quo. It was rejected as *sufficient*, not as useful. It did not
fire at all on the deploy, and when it does fire it carries no
structured content: no tier, no credential path, no statement of
whether a tested library path already covers the operation. This
protocol is additive to the prompt. Both run.

**Rejected: a single read → write → destructive scale.** It would have
cleared the incident's credential-bearing read as benign. See §2.6.

**Rejected: gate the destructive config-reset capability instead of
deleting it.** A gate around code with zero production callers adds a
maintained control protecting nothing, and leaves the capability
reachable. Deletion removes the risk outright; if a real need appears,
the code is in git history. See §7's G2 row.

**Rejected: write this as an ADR.** An ADR records a point-in-time
decision and is superseded rather than updated
([docs/README.md](README.md)). This document's classification table and
gap register are expected to grow as new live-touching surfaces land,
which is what an operations doc is for.
