import { describe, expect, it, vi } from "vitest";

import { commandDigest } from "../packages/db/src/canonical-command.js";
import {
  PrincipalAwareRuntimeService,
  type RuntimeRepositoryBoundary
} from "../packages/db/src/runtime-service.js";
import {
  RuntimeTypeRegistry,
  exampleOperationRegistrations,
  exampleTypeRegistrations
} from "../packages/db/src/runtime-registry.js";
import type {
  AppendRuntimeCommand,
  AuthorizationDenialInput,
  RuntimeOperationResult
} from "../packages/db/src/runtime-repository.js";

const workItemId = "00000000-0000-4000-8000-000000000010";
const observationId = "00000000-0000-4000-8000-000000000011";
const actionId = "00000000-0000-4000-8000-000000000012";
const resultId = "00000000-0000-4000-8000-000000000013";
const approvalId = "00000000-0000-4000-8000-000000000014";

class FakeRepository implements RuntimeRepositoryBoundary {
  readonly appendCommand = vi.fn<(command: AppendRuntimeCommand) => Promise<RuntimeOperationResult>>(
    async (command) => ({
      status: "inserted",
      terminal_status: command.terminal_status ?? "succeeded",
      operation_record_id: command.records[0]!.record_id,
      result_record_ids: command.records.slice(1).map((record) => record.record_id)
    })
  );
  readonly recordAuthorizationDecision = vi.fn<
    (input: AuthorizationDenialInput) => Promise<RuntimeOperationResult>
  >(async () => ({
    status: "inserted",
    terminal_status: "succeeded",
    operation_record_id: "00000000-0000-4000-8000-000000000099",
    result_record_ids: []
  }));
}

describe("principal-aware runtime service", () => {
  it("constructs an attributed action, typed result, and provenance graph", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);
    const input = allowedInput();

    await service.execute(input);

    expect(repository.appendCommand).toHaveBeenCalledOnce();
    const append = repository.appendCommand.mock.calls[0]![0];
    expect(append.command_digest).toBe(input.command_digest);
    expect(append.command_context.authenticated_principal_ref).toBe("principal://example/operator");
    expect(append.records).toHaveLength(2);
    expect(append.records[0]).toMatchObject({
      record_id: actionId,
      kind: "action_attempt",
      type: "runtime.action.attempt",
      payload: {
        work_item_id: workItemId,
        handler_id: "example-reconcile-handler",
        correlation_id: "correlation-1",
        command_digest: input.command_digest,
        outcome: "succeeded",
        result_refs: [{ kind: "result", id: resultId }]
      }
    });
    expect(append.records[0]!.payload).not.toHaveProperty("command_context");
    expect(append.records[1]).toMatchObject({
      record_id: resultId,
      kind: "result",
      type: "example.reconciliation.delta",
      schema_ref: "example://schemas/reconciliation-delta/v1",
      payload: { changed: true }
    });
    expect(append.edges).toEqual([
      { from_record_id: actionId, relation: "caused_by", to_record_id: workItemId, ordinal: 0 },
      { from_record_id: actionId, relation: "derived_from", to_record_id: observationId, ordinal: 0 },
      { from_record_id: actionId, relation: "produced", to_record_id: resultId, ordinal: 0 }
    ]);
    expect(repository.recordAuthorizationDecision).not.toHaveBeenCalled();
  });

  it("rejects a digest that does not match the RFC8785 command", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);

    await expect(
      service.execute({ ...allowedInput(), command_digest: `sha256:${"f".repeat(64)}` })
    ).rejects.toThrow(/supplied command digest/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("binds authorization evidence to the registered operation action", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);
    const input = allowedInput();
    input.command_context.authorization.action = "state.read";

    await expect(service.execute(input)).rejects.toThrow(/authorization action.*registered action/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("requires evidence when the registered operation requires approval", async () => {
    const repository = new FakeRepository();
    const service = createService(repository, undefined, true);

    await expect(service.execute(allowedInput())).rejects.toThrow(/requires approval evidence/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("rejects approval evidence when operation metadata declares no approval", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);
    const input = allowedInput();

    await expect(
      service.execute({
        ...input,
        approval_evidence: approvalEvidence(input.command_digest)
      })
    ).rejects.toThrow(/does not accept approval evidence/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it.each([
    ["digest", { command_digest: `sha256:${"e".repeat(64)}` }, /approved command digest/i],
    ["revision", { action_revision: 2 }, /approval action revision/i]
  ])("rejects approval %s mismatch", async (_case, override, message) => {
    const repository = new FakeRepository();
    const service = createService(repository, undefined, true);
    const input = allowedInput();

    await expect(
      service.execute({
        ...input,
        approval_evidence: { ...approvalEvidence(input.command_digest), ...override }
      })
    ).rejects.toThrow(message);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("persists valid approval evidence and links the action with approved_by", async () => {
    const repository = new FakeRepository();
    const service = createService(repository, [actionId, approvalId, resultId], true);
    const input = allowedInput();

    await service.execute({
      ...input,
      approval_evidence: approvalEvidence(input.command_digest)
    });

    const append = repository.appendCommand.mock.calls[0]![0];
    expect(append.records).toHaveLength(3);
    expect(append.records[1]).toMatchObject({
      record_id: approvalId,
      kind: "approval",
      type: "runtime.command.approval",
      payload: {
        work_item_id: workItemId,
        action_revision: 1,
        command_digest: input.command_digest,
        approved_by_principal_ref: "principal://example/approver",
        decision: "approved"
      }
    });
    expect(append.edges).toContainEqual({
      from_record_id: actionId,
      relation: "approved_by",
      to_record_id: approvalId,
      ordinal: 0
    });
  });

  it("binds the approval principal to trusted approver context", async () => {
    const repository = new FakeRepository();
    const service = createService(repository, undefined, true);
    const input = allowedInput();

    await expect(
      service.execute({
        ...input,
        approval_evidence: {
          ...approvalEvidence(input.command_digest),
          approved_by_principal_ref: "principal://example/untrusted-approver"
        }
      })
    ).rejects.toThrow(/approval principal.*trusted approver context/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("binds approval authorization to the built-in approval action", async () => {
    const repository = new FakeRepository();
    const service = createService(repository, undefined, true);
    const input = allowedInput();
    const evidence = approvalEvidence(input.command_digest);
    evidence.approver_context.authorization.action = "state.reconcile";

    await expect(
      service.execute({ ...input, approval_evidence: evidence })
    ).rejects.toThrow(/runtime\.command\.approve/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("rejects unregistered, mismatched, and invalid declared effects", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);
    const cases = [
      {
        result_type: "example.report",
        schema_version: 1,
        schema_ref: "example://schemas/report/v1",
        target: target(),
        payload: { content_ref: "artifact://report" }
      },
      {
        result_type: "example.reconciliation.delta",
        schema_version: 1,
        schema_ref: "example://schemas/wrong/v1",
        target: target(),
        payload: { changed: true }
      },
      {
        result_type: "example.reconciliation.delta",
        schema_version: 1,
        schema_ref: "example://schemas/reconciliation-delta/v1",
        target: target(),
        payload: { changed: "yes" }
      }
    ];

    for (const effect of cases) {
      const command = { ...canonicalCommand(), declared_effects: [effect] };
      await expect(
        service.execute({
          ...allowedInput(),
          command,
          command_digest: commandDigest(command)
        })
      ).rejects.toThrow();
    }
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("rejects payload attempts to spoof trusted identity fields", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);
    const command = {
      ...canonicalCommand(),
      arguments: { authenticated_principal_ref: "principal://spoofed/user" }
    };

    await expect(
      service.execute({ ...allowedInput(), command, command_digest: commandDigest(command) })
    ).rejects.toThrow(/reserved for trusted command context/i);
    expect(repository.appendCommand).not.toHaveBeenCalled();
  });

  it("routes denied authorization to the audit-only repository boundary", async () => {
    const repository = new FakeRepository();
    const service = createService(repository);
    const input = allowedInput();
    input.command_context.authorization.result = "denied";
    input.command_context.authorization.reason_codes = ["policy.not_allowed"];

    await service.execute(input);

    expect(repository.appendCommand).not.toHaveBeenCalled();
    expect(repository.recordAuthorizationDecision).toHaveBeenCalledWith({
      stream_id: "stream-1",
      operation_type: "example.state.reconcile",
      target: target(),
      request_id: "request-1",
      command_context: input.command_context
    });
  });
});

function createService(
  repository: FakeRepository,
  ids: string[] = [actionId, resultId],
  approvalRequired = false
): PrincipalAwareRuntimeService {
  return new PrincipalAwareRuntimeService(
    repository,
    new RuntimeTypeRegistry(
      exampleTypeRegistrations,
      exampleOperationRegistrations.map((registration) => ({
        ...registration,
        approval_required: approvalRequired
      }))
    ),
    { createId: () => ids.shift()! }
  );
}

function canonicalCommand() {
  return {
    canonicalization_version: "jcs-rfc8785-v1" as const,
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: workItemId,
    action_revision: 1,
    target: target(),
    arguments: { desired: { ready: true } },
    declared_effects: [
      {
        result_type: "example.reconciliation.delta",
        schema_version: 1,
        schema_ref: "example://schemas/reconciliation-delta/v1",
        target: target(),
        payload: { changed: true }
      }
    ]
  };
}

function allowedInput() {
  const command = canonicalCommand();
  return {
    stream_id: "stream-1",
    idempotency_key: "idempotency-1",
    command,
    command_digest: commandDigest(command),
    command_context: {
      authenticated_principal_ref: "principal://example/operator",
      effective_actor: { type: "agent" as const, id: "example-agent" },
      request_origin: "worker" as const,
      authorization: {
        decision_id: "decision-1",
        action: "state.reconcile",
        result: "allowed" as "allowed" | "denied",
        policy_version: "policy-v1",
        reason_codes: ["policy.allowed"]
      }
    },
    action: {
      trigger: { type: "user_request" as const, ref: { kind: "work_item" as const, id: workItemId } },
      causation_ref: { kind: "work_item" as const, id: workItemId },
      correlation_id: "correlation-1",
      request_id: "request-1",
      tool_invocation_id: "tool-call-1",
      input_refs: [{ kind: "event" as const, id: observationId }],
      started_at: "2026-08-23T12:00:00.000Z",
      finished_at: "2026-08-23T12:00:01.000Z",
      outcome: "succeeded" as const
    }
  };
}

function approvalEvidence(approvedCommandDigest: string) {
  return {
    work_item_id: workItemId,
    operation_type: "example.state.reconcile",
    action_revision: 1,
    command_digest: approvedCommandDigest,
    approved_by_principal_ref: "principal://example/approver",
    decision: "approved" as const,
    decided_at: "2026-08-23T11:59:00.000Z",
    approver_context: {
      authenticated_principal_ref: "principal://example/approver",
      effective_actor: { type: "user" as const, id: "example-approver" },
      request_origin: "http" as const,
      authorization: {
        decision_id: "approver-authz-1",
        action: "runtime.command.approve",
        result: "allowed" as const,
        policy_version: "policy-v1",
        reason_codes: ["policy.approver_allowed"]
      }
    }
  };
}

function target() {
  return { type: "example.environment", id: "production" };
}
