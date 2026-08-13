# Vending Worker

The vending worker is the first vertical slice. M1 supports only fake/manual lead ingestion and call transcript ingestion.

## Current Behaviors

- Validate a vending location lead with `VendingLeadSchema`.
- Validate a call transcript with `VendingCallTranscriptSchema`.
- Produce an approval-gated placeholder follow-up draft from a transcript.

Duplicate lead detection is represented in the Postgres migration with a unique `(company_name, location_name)` constraint.
