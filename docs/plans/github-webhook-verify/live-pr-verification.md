# Live PR-event verification (issue #108)

Throwaway artifact for the pull_request-event half of #108's live verification.
The issue_comment half was already verified against a genuine delivery
(see #108's own comment thread). This file exists only to produce a real
`pull_request: opened` event against the same App/webhook; the PR it lives on
is expected to be closed without merging once the endpoint's verification is
confirmed in the receiving instance's runtime logs.
