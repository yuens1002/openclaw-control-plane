# Plans

Feature plans that use the agentic-workflow cadence live here. See
[`docs/AGENTIC-WORKFLOW.md`](../AGENTIC-WORKFLOW.md) for this repo's adapter
of the generic `/agentic-workflow` protocol — roles, gates, and enforcement
hooks.

Use one directory per feature:

```text
docs/plans/<feature-slug>/
  plan.md
  ACs.md
  review.md
```

`plan.md` defines deliverables, owners, and commit schedule. `ACs.md` tracks
acceptance criteria with Plan ref, Role, Agent, QC, and Reviewer columns.
`review.md` is the last machine review over docs, code, and tests before human
approval.
