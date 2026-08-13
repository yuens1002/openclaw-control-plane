# OpenClaw Tools

The OpenClaw adapter exposes stable tool functions that call the control-plane
API without embedding business-specific workflow logic.

## M1 Tool Surface

- `ingest_event(eventEnvelope)`
- `get_pipeline_state(domain)`
- `run_pipeline(domain, input)`
- `pause_pipeline(domain)`
- `resume_pipeline(domain)`
- `retry_run(runId)`

The adapter should remain a transport wrapper. Pipeline-specific behavior belongs in workers.
