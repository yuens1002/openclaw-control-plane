# DRAFT ISSUE — not filed

This file is a **draft only**. Filing is an outward-facing action
reserved for a human; nothing in this branch files it. Copy the body
below into a new issue when ready.

Public-Repo Rule check: the text below names no service, domain, client,
private repo, or credential value. Keep it that way if it is edited
before filing.

---

**Title:** Delete the unused destructive config-reset capability from the
setup API client

**Labels (suggested):** `security`, `cleanup`

---

## Body

### Summary

`packages/openclaw-setup-applier/src/setup-api-client.ts` exposes a
`reset()` method on the client returned by `createSetupApiClient`. It
calls the wrapper's destructive config-reset endpoint. Per
`docs/setup-profile-applier.md` ("Do not call the mutating
`/setup` endpoints yourself"), that endpoint **deletes the target
instance's configuration file outright**.

It has **zero production callers**. Delete it rather than gate it.

### Why deletion rather than a gate

`docs/live-instance-operations.md`
classifies this operation as **destructive** on the mutation axis, and
the rule for that tier is Forbidden — not gated, not confirmed, not
available.

A gate around code that nothing calls is a control that protects
nothing while still needing to be maintained, tested, and understood by
the next reader. It also leaves the capability reachable: any future
caller only has to satisfy the gate. Deleting it removes the capability
from the module's surface entirely, and the code remains recoverable
from git history if a real need ever appears.

The narrow rule in `docs/setup-profile-applier.md` already says not to
call this endpoint outside the applier's tested path. The applier's
tested path never calls it. That makes the method dead weight whose only
effect on the codebase is to keep a destructive operation one function
call away.

### Deletion surface

One method, plus the tests that exist only to test it:

- `packages/openclaw-setup-applier/src/setup-api-client.ts` — the
  `reset:` entry on the object returned by `createSetupApiClient`.
  One line.
- `tests/openclaw-setup-applier-setup-api-client.test.ts` — five
  references in all: three `client.reset()` call sites (lines 80, 115,
  139), the `"POSTs to /setup/api/reset"` test title (line 70), and the
  asserted request URL (line 82). Two of the three call sites exercise
  auth-header behavior that other methods on the same client also
  cover, so they can be re-pointed at a non-destructive method rather
  than deleted outright — a reviewer should confirm the auth-header
  assertions survive the change.

Nothing else in `packages/**`, `apps/**`, or `deploy/**` references
`reset` on this client. Verified by repo-wide search at the time of
writing; re-verify before merging, since a caller added in the meantime
changes the argument.

### Proposed change

1. Remove the `reset` entry from the object returned by
   `createSetupApiClient`.
2. Remove or re-point the five test references listed above, keeping
   equivalent auth-header coverage.
3. Update `docs/setup-profile-applier.md`'s
   "Do not call the mutating `/setup` endpoints yourself" section: the
   endpoint still exists on the instance and the prohibition still
   stands, but this repo's client no longer offers a way to call it.
   The section should say so rather than continuing to imply the method
   is available.

### Out of scope

This does not touch the endpoint itself, which lives upstream in the
wrapper, nor the mutating `run` endpoint, which has a legitimate tested
caller.

### Acceptance

- `reset` no longer appears on the setup API client's surface.
- No test asserts on the destructive endpoint.
- The applier doc reflects the removal without weakening its existing
  prohibition.
- `docs/live-instance-operations.md`'s gap register (G2) can be
  updated from "escalated" to "closed" once this merges.
