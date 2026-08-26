# Denied Tool Invocation Audit Plan

Issue: https://github.com/yuens1002/openclaw-control-plane/issues/71
Branch: `fix/denied-tool-invocation-audit`
Status: approved for implementation as a non-policy provenance correction

## Outcome

Preserve an MCP tool invocation identifier when a registered runtime command
is denied by authorization. The denial must remain effect-free while retaining
enough typed evidence to correlate the durable audit record with the originating
tool call.

## Current State

- The MCP host generates a bounded invocation identifier for each tool call.
- The adapter sends that identifier as `x-tool-invocation-id` for runtime
  command requests.
- The API validates the header and uses it to classify the request origin as
  `tool`.
- Successful commands retain the identifier, but the denied-command branch
  drops it before persistence.

## Decisions

1. Reuse the validated header value; do not add caller-controlled identity or
   authorization fields.
2. Carry the optional identifier through `recordCommandDenial` and persist it
   in the typed `runtime.authorization.denied` payload.
3. Include the identifier in canonical denial evidence so the durable record
   and its command digest describe the same provenance.
4. Requests without the header remain valid, retain `request_origin: http`, and
   omit the optional field.
5. A denied command continues to create only its audit record. It must not
   create an action attempt, result, or external effect.
6. Keep the change generic to any MCP or tool transport and free of deployment
   identities, endpoints, or credentials.

## Deliverables

| ID | Deliverable | Owner | Artifacts |
| --- | --- | --- | --- |
| D1 | Workflow contract | project-manager | plan, ACs, and review record |
| D2 | Typed provenance propagation | backend-architect | API, service, repository, and contract shape |
| D3 | Denial regression coverage | test-engineer | HTTP, PostgreSQL, and MCP tests |
| D4 | Portable documentation and release | project-manager | architecture note, changelog, patch version |
| D5 | Exact-head verification | test-engineer | focused/full checks, CI, external review, merge evidence |

## Implementation Sequence

1. Commit this plan and acceptance contract before implementation.
2. Add failing tests for tool-origin denial persistence and HTTP-origin
   omission.
3. Propagate the optional identifier through the narrow denial path.
4. Update generic provenance documentation and prepare a patch release.
5. Run focused tests, the PostgreSQL suite, full tests, typecheck, build,
   production audit, Docker checks, public-language scan, and diff checks.
6. Record exact-head review, publish a PR, clear CI and external review, and
   merge only the reviewed head.

## Non-Goals

- Auditing every successful read authorization.
- Changing authorization grants, principals, delegation, or execution policy.
- Exposing consequential tools to a consumer.
- Accepting arbitrary invocation IDs in runtime payload bodies.
- Naming a private deployment or consumer in public artifacts.

## Release Gates

- Tool-origin denials retain request and invocation identifiers plus trusted
  principal, actor, origin, and authorization evidence.
- Headerless denials remain backwards compatible and omit the optional field.
- The denied path creates no action attempt or result.
- Contract, HTTP, PostgreSQL, and MCP regression tests pass.
- Exact-head CI and external review contain no unresolved blocker.
