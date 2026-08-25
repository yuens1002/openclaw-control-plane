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
| read | **returns** a secret | For a direct human CLI invocation: allowed only with an explicit acknowledgement that the output will contain secrets, and only when scoped to a named target. Never pipe the output into a log, a file, or a transcript. For an in-process programmatic read that never echoes captured output to this process's own stdout: mandatory service scoping plus that non-echo property stand in for the explicit acknowledgement — narrower than the human rule, judged sufficient in G4's disposition (§7), not a general substitution available to any future caller. A caller that deliberately surfaces the value to the operator who requested it (prints or persists it) still must scope to a named target, the same as the human path, and its acknowledgement is the invocation itself: a named command whose stated purpose is to hand that operator that credential for that target (e.g. `provision`, `bootstrap`) — not a general license for a programmatic path to print or persist an unrelated value it happened to read. | Exemplar (human path): `guard-cli.ts`'s `checkGuard` requires `--i-know-this-prints-secrets` before a variable listing runs, and never spawns the underlying CLI when the check fails. Programmatic path, meets the row by the narrowed rule above rather than as an exemplar of the acknowledgement mechanism: `railway-variables.ts`'s `listRailwayVariables`/`readRailwayVariable` require `service` as a mandatory parameter (no unscoped fallback), and every real runner that calls them — `openclaw-railway-installer/src/client-cli.ts`'s, `openclaw-setup-applier/src/cli.ts`'s, and `openclaw-setup-applier/src/onboarding-cycle-cli.ts`'s own `runCommand` — deliberately never writes captured stdout to this process's own stdout, each pinned by a real-child-process regression test. `checkGuard` itself is not reused here; it is a CLI-entrypoint whitelist for exactly two subcommands and would reject every other command (`redeploy`, `domain list`, `deploy`, ...) these runners also carry. Gap G4, §7 — narrowed, not built as a shared guard. |
| read | **requires** a secret | Allowed **only** if the secret reaches the process by stdin or environment. Forbidden if it is interpolated into the argument string — §2.4, no exceptions. | Exemplar: `setup-api-client.ts`'s `createSetupApiClient` builds the auth header inside the process from a value never placed on a command line. Counter-example: the Manual Install block in `deploy/openclaw-railway/README.md` passes `SETUP_PASSWORD` as an inline `-v "NAME=VALUE"` argument. |
| idempotent-write | any | Allowed through tested library code. Requires **both** halves: compare-then-write *and* post-write verification (§5). Ad hoc use is not permitted where a library path exists. | Exemplar (both halves): `packages/openclaw-setup-applier/src/apply-profile.ts`'s `applyProfile` skips the mutating call when its opening `getStatus()` already reports configured, then re-reads status after the write and throws if it did not take. Second exemplar: `patch-allowed-origins.ts`'s `patchAllowedOrigins` compares before writing, skipping the POST (and therefore a live gateway restart) when the origin is already present, then re-reads the config and throws if the origin is absent after the write reported success. Also, **for the compare/post-write properties only, not for its tier**: `provision-client.ts`'s `updateClientTemplateRef` and `updateClientOpenClawRef` read the current ref, no-op without redeploying when it already matches, refuse a mismatch, and verify after writing. Those functions are classified `restart-or-redeploy-triggering` (per §2.1's take-the-highest-tier rule, since they redeploy), and that row's stricter procedure is the one that governs them -- they appear here only as an illustration of the two required halves (gap G1, §7). |
| unconditional-write | any | Not permitted ad hoc. In library code, requires an explicit stated reason why a pre-read comparison is impossible, plus post-write verification. Otherwise it must be converted to idempotent-write. | Counter-example: `import-workspace-files.ts`'s `importWorkspaceFiles` POSTs without a pre-read comparison (gap G3, §7). Note on `importWorkspaceFiles`: the missing pre-read is why it appears here, but its **effective tier is the row below** — `docs/plans/workspace-identity-transport/ACs.md`'s AC-XPORT-003 states that calling the import endpoint stops the gateway as a side effect. That statement is second-hand in this repo: it is asserted in the AC's premise and is the stated reason the module never retries, but the independent upstream re-confirmation recorded in that plan attaches to AC-XPORT-005 (response shape), not to the gateway stop. Classified at the higher tier because over-classifying under unresolved provenance is the safe direction; the module's own marker carries the same word. |
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

*What "naming the target" requires in practice.* A required, explicit target
argument that cannot silently default to an ambiently-linked service
satisfies this — the operator has to type the name. The client-ref update
paths meet it that way (`service` is required, reaches the CLI as
`--service`, and `guard-cli.ts` rejects unscoped invocations), and add a
separate live-state precondition on top. A second argument echoing the same
name back was considered and rejected: it adds friction to every legitimate
call and is the kind of ceremony operators paste past without reading, so it
would buy confirmation theatre rather than confirmation. An interactive
prompt was likewise rejected for paths that run from scripts. Recorded here
because this question recurs on review.

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

Open gaps are tracked on GitHub so they survive the session that found
them. G3, G5's concurrency half, and G8 were tracked in issue #47 and
are dispositioned below — G3 and G8 by fix, G5's concurrency half by a
recorded decision to accept the risk. G6 was also tracked in issue #47
and remains open: it needs design agreement on a client registry (or
an equivalent independent source of truth) before any code, which is
out of scope for the gap-closure bundle that closed the other three.
G4 was tracked in issue #45 and is closed below. An entry here that
says "still open" with no decision attached is a bug in this document,
not a neutral state -- that is how the stale entries corrected in #46
arose.

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

**G5 — post-write verification: CLOSED. Concurrency: CLOSED, accepted
risk, decided under issue #47.** The verification half was this
document's first recommended follow-up, because §2.5's idempotent-write
rule requires *both* compare-then-write and post-write verification
while `packages/openclaw-railway-installer/src/patch-allowed-origins.ts`
had only the first — the protocol documented a rule its own most-cited
example did not satisfy. That half is fixed: the function re-reads the
raw config after the POST and throws if the origin is absent, mirroring
`applyProfile`'s post-run status re-read. No wait precedes that read,
deliberately — `/setup/api/config/raw` is served by the wrapper from
the config file and never proxied to the gateway, so the POST's gateway
restart does not gate it.

**Concurrent-loss detection, not concurrency control** (renamed from
the original "concurrency control" filing, which overstated it). The
read-modify-write window between the GET and the POST means a
concurrent write to the same config is silently lost, last-write-wins
over the whole document.

*Previously recommended fix, withdrawn:* compare the document read
during post-write verification against what was written, and fail on
divergence. Re-examined under issue #47 and rejected on the merits, not
just on urgency: that comparison watches the POST-to-verify window, not
the GET-to-POST window this gap is actually about. A concurrent writer
whose change this function's own POST clobbers leaves the
verification read matching exactly what this function wrote — the
clobber it exists to catch produces no divergence for it to see. It
would only catch a *different, near-zero-width* race (something else
writing in the instant between this function's own POST and its
immediately-following, un-delayed verification GET), not the gap
description's actual race. Renaming the recommended fix to "detection"
without fixing which window it watches would have shipped a check that
reports nothing on the exact failure it was named for.

A real fix for the window that matters needs either a provider-side
conditional write (the CLI exposes none, verified under G4) or a lock
shared by every writer — the same wall G1 hit — or a second GET
immediately before the POST to detect drift in the GET-to-POST window
itself, not the POST-to-verify one. None of those are built here.

*Accepted instead, on exposure:* the writers of this config are the
provisioning path, the applier, and manual edits, and those are
sequential in practice — one operator, one run at a time. Absent
evidence of real concurrent writers, and given that the one fix already
on record for this gap doesn't actually address it, leaving the window
open with this reasoning recorded is preferred over shipping a check
that would read as protection without being any. Reprioritise, and
build one of the real options above, if that exposure assumption stops
holding.

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

**G3 — trigger enforcement: CLOSED. Pre-read comparison itself: still
deferred, as designed.** `import-workspace-files.ts`'s
`importWorkspaceFiles` POSTs the archive every call. Per the upstream
note in that module's header (second-hand in this repo, recorded from
the upstream wrapper's source rather than verified here, and not
re-confirmed against that source by this document), the server side
extracts into the data directory
without deleting existing files first, so the operation overwrites
per-file rather than wiping — but nothing compares before writing.
Still unwired from both provisioning paths, still built and exported.
*Recommended fix, not built here:* add a pre-read comparison before
this is ever wired into a provisioning path. Low urgency while it has
no production callers; not low urgency the day it gains one.

*That deferral's trigger is now enforced, not just documented.*
"Fix it when it gains a caller" previously depended on whoever wired
it up having read this register first, which is precisely the kind of
precondition that gets missed.
`tests/openclaw-railway-import-workspace-files.test.ts`'s
"importWorkspaceFiles has no production callers" suite source-scans
every file under `apps/*/src`, `packages/*/src`, and `workers/*/src`
for an import specifier naming `import-workspace-files` and fails if
one appears — same source-text-scan shape as the G4
closure's equivalent check, with the same known limitation (it cannot
catch a future re-export under an unrelated name). The day someone
wires this module into a provisioning path, that test fails and points
here instead of shipping the still-missing pre-read comparison silently.

**G4 — CLOSED (narrowed), 2026-08-23.** Filed as issue #45 as
"programmatic Railway variable calls bypass the human-CLI guard":
`guard-cli.ts`'s `checkGuard` enforces explicit service scoping and a
secret-echo acknowledgement, but only for direct human invocation —
`checkGuard` is imported nowhere outside `guard-cli.ts` itself and its
test. `railway-variables.ts`'s `listRailwayVariables` and
`readRailwayVariable` (seven call sites total: `readRailwayVariable`
called five times in `provision-client.ts`; `listRailwayVariables`
called twice in `apply-profile.ts`) call the underlying runner directly,
with neither protection. `writeRailwayVariable` was also named in the original
gap text but does not belong to this row — it does not return a secret,
it writes one via `--stdin`, and never logs, prints, or returns the value
it wrote.

The issue posed five design questions and asked, as the first and
gating one: does in-process exposure still matter once nothing is
echoed? Decided **no**, for this repo's current threat model, once the
actual mechanism was traced rather than assumed:

- Every one of the seven call sites is reachable through one of three
  real runners, each wired up by a different CLI entrypoint:
  `openclaw-railway-installer/src/client-cli.ts`'s `runCommand`
  (`provisionClientInstance`, invoked directly), `openclaw-setup-applier
  /src/cli.ts`'s `runCommand` (`applyProfile`/`dryRunApplyProfile`,
  invoked directly), and `openclaw-setup-applier/src/onboarding-cycle-
  cli.ts`'s own separate `runCommand` (the same two call graphs, reached
  instead through its `bootstrap` subcommand's `bootstrapOnboardingCycle`,
  which composes provisioning and profile-application into one bootstrap
  run — its sibling `regression-check` subcommand's `runRegressionCheck`
  only writes a variable and never reaches either reader call graph, so
  it is not a fourth path into this row). All three runners deliberately
  never write captured stdout to this process's
  own stdout — confirmed in code, not assumed — and all three are pinned
  by an existing real-child-process regression test, each titled "never
  writes the spawned process's stdout to this process's own stdout, even
  though it's still captured for parsing":
  `tests/openclaw-railway-client-cli.test.ts` for the first,
  `tests/openclaw-setup-applier-cli.test.ts` for the second (added by
  this closure — it had no real-spawn coverage of any kind beforehand),
  and `tests/openclaw-setup-applier-onboarding-cycle-cli.test.ts` for the
  third. The one runner that *does* echo (`cli.ts`/`index.ts`, the
  marketplace-install path) never calls any of the reader functions, or
  the modules that call them — confirmed by source-text scan, not
  assumed, and pinned by `tests/openclaw-railway-cli.test.ts`'s
  "marketplace-install path never reads Railway variables" suite, which
  matches each file's actual import specifiers — a `from` clause, a bare
  side-effect import, or a dynamic `import(...)` — not a bare mention
  (`index.ts`'s own doc comments legitimately name `provision-client.ts`
  as a caller of an unrelated export) so a future import of
  `railway-variables.js`, `provision-client.js`, or `apply-profile.js`
  into either file fails that test. Coarser than an import-graph check —
  it cannot catch a re-export under a different name — but sufficient for
  the direct-import regression path this closure actually depends on.
- `service` is a required parameter on every reader function with no
  unscoped fallback, meeting this row's scoping requirement structurally
  rather than by a runtime check.
- What remains is real and was weighed, not overlooked: every call still
  materializes every variable on the service in this process's memory to
  select one (issue #45's "why every read is a broad read" — no targeted
  CLI read exists, confirmed against the CLI, not assumed). A guard at this
  boundary cannot narrow that; the CLI offers no narrower call to guard
  down to. What it would add is deliberateness and reviewability of
  *who* reads secrets, not reduced exposure — and building that guard
  well needs an allowlist of permitted callers, not a boolean flag a
  future call site can paste past unread (a flag proves nothing an
  attentive reviewer's diff review doesn't already catch). Judged not
  worth the ceremony while every caller is internal, trusted process
  code that already satisfies the row's actual requirements.

*Previously recommended fix, withdrawn:* moving the check to the
general process-spawn boundary. Traced against the real runners rather
than assumed: `checkGuard` whitelists exactly two subcommands
(`variable list`/`set`) and rejects everything else, so wrapping the
general runner with it as-is would reject `redeploy`, `domain list`,
`deploy`, and every other command these same runners carry. A viable
version would need splitting `checkGuard`'s CLI-entrypoint whitelist
from its secret-echo gate — not attempted, because the exposure it
would close is already closed by the echo suppression above.

Not every caller only consumes the value in-process. `client-cli.ts`'s
`provision` subcommand unconditionally `console.log`s the setup password
to the operator and persists both credentials to `.env.local` and the
handoff markdown file when those writers are enabled — the password
directly (`buildProvisionHandoff`'s "Setup Auth" section), the gateway
token embedded in the handoff link's `#token=` URL fragment — regardless
of whether the value came from a fresh `provisionClientInstance` call or,
on a `reusedExistingService` rerun, from its reused-service branch's
`readRailwayVariable` read-back. `onboarding-cycle-cli.ts`'s `bootstrap`
subcommand does the same thing on top of the same composed call (it calls
`bootstrapOnboardingCycle`, which calls `provisionClientInstance`
directly): it unconditionally `console.log`s `result.provision.setupPassword`
and `result.provision.dashboardUrl` (the latter embedding the gateway
token) too. That is deliberate design in both CLIs, not an oversight this
entry missed: it
is the credential handoff each command exists to produce, requested by
the operator who named the client on the command line (`--client-name`;
neither CLI accepts a raw `--service` flag on this subcommand — the
service is resolved internally as the sole service in that client's
linked project), for the one instance they just asked about — not an
unacknowledged bulk listing piped into a log or transcript, which is
what this row's rule actually guards against; see the amended rule cell
in §2.5. `updateClientRefVariable`'s ref read and `dryRunApplyProfile`'s
presence check, by contrast, never surface a value at all — the former
uses it only for an in-process auth header or comparison, the latter
converts it to a boolean before
returning. If a *future* caller starts printing, logging, or persisting
a value this deliberate-handoff distinction doesn't cover, that is a new
gap, not a reopening of this one. §2.5's read/returns-a-secret row
records the mechanism this entry closes on.

**G6 — the "never touches another service" invariant is prose, not
code-enforced.** The doc comments on `provision-client.ts`'s
`updateClientTemplateRef` and `updateClientOpenClawRef` state it; the
only actual enforcement is that `service` is a required parameter that
reaches the CLI as an explicit `--service` flag. Nothing asserts at run
time that the named service is the intended one. (Related, and
deliberately not opened as its own gap: `provisionClientInstance` runs
a volume-attach command unscoped, but that is initial provisioning,
outside §1's scope.) *The previously recommended fix was circular* and is withdrawn: "assert
the resolved target matches the caller-declared target" compares
`options.service` to itself, since that parameter *is* the declaration.
It proves nothing. (The same objection applies to adding a second
argument echoing the service name back, which was raised in review on
the G1 work and declined for that reason -- see §5.2.)

*Partially mitigated by G1, with an important limit.* The
compare-and-swap added to both update paths means a mistyped service
name is usually refused: the wrong client's current ref will not match
the expected ref the caller declared. That mitigation disappears
exactly where it is most needed, though. `OPENCLAW_TEMPLATE_REF`
defaults to `template-lock.json`'s `pinnedCommit`, so clients
provisioned without an explicit override all carry the *same* value --
and a typo landing on such a client passes the check cleanly and
redeploys it. Homogeneous fleets are the normal case for the template
ref, so treat this as protection against hitting a
differently-versioned target, not against hitting the wrong target.

*Recommended fix:* validate the named service against an independent
source of truth -- a client registry the caller does not supply -- so
the check has something real to disagree with. Future work.

*Investigated under issue #47, still open by decision, not oversight.*
One candidate independent source of truth was checked before deferring
further: `provisionClientInstance`'s `--client-name` resolves to a
service via `selectSoleService` against the named client's linked
project, which is real (caller-independent) validation, not circular.
But `client-cli.ts`'s `update-ref` and `update-openclaw-ref`
subcommands do not go through that path -- `parseUpdateRefArgs` and
`parseUpdateOpenClawRefArgs` both require `--service` directly, with no
`--client-name` flag and no linked-project resolution, so there is
nothing on those two paths today for a caller-declared service name to
disagree with. Building the registry this entry recommends therefore
means either adding new persistent state (a client-name -> service
mapping the update paths don't currently have any way to look up) or
changing the update CLI's parameter model to take `--client-name`
instead of `--service` and resolve it the way `provision` does --
either is a real design decision, not a mechanical fix, so this stays
open rather than being built inside a gap-closure bundle.

### Explicitly excluded from this document's scope, but fixed via issue #47

**G8 — CLOSED.** A Railway-CLI test fixture was duplicated: a shared
fixture exists at `tests/fixtures/fake-railway-runner.ts`, and four
test files (`openclaw-railway-installer-readiness.test.ts`,
`openclaw-setup-applier-railway-variables.test.ts`,
`openclaw-setup-applier-apply-profile.test.ts`,
`openclaw-setup-applier-onboarding-cycle.test.ts`) separately declared
their own local class of the same name with a different constructor
shape. This is test hygiene rather than live-instance safety -- no live
target is reachable from a test fixture -- so it stays out of this
document's scope for classification purposes.

It was not merely cosmetic, though, and the original wording undersold
it. Duplicated fakes mean a fix to one does not reach the others: a
fake that failed to reflect its own writes was corrected in one test
double, and the identical defect then recurred in a second, because the
correction landed on the instance rather than the pattern. In both
cases the consequence was a test that passed while asserting nothing.

All four local declarations now import the shared `FakeRailwayRunner`
instead. Two behavioral differences the local classes carried had to be
either reproduced explicitly or shown not to matter, rather than
silently dropped: the shared fixture's default domain differs from the
literal domains three of the four files asserted against, so each now
calls `setDomainList` with its own expected value; and the shared
fixture holds its last queued `service list` response once exhausted
rather than falling back to empty, which the onboarding-cycle file's
provisioning-flow test now relies on deliberately (see that file's
`newRunner` comment) instead of the boolean `upCalled` flag it used to
carry. All previously-passing assertions still pass unchanged.

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
