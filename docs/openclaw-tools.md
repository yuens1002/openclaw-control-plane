# OpenClaw Tools

The OpenClaw adapter exposes stable tool functions that call the control-plane API without embedding vending business logic.

## M1 Tool Surface

- `ingest_event(eventEnvelope)`
- `get_pipeline_state("vending")`
- `run_pipeline("vending", input)`
- `pause_pipeline("vending")`
- `resume_pipeline("vending")`
- `retry_run(runId)`

The adapter should remain a transport wrapper. Pipeline-specific behavior belongs in workers.
