import { describe, expect, it } from "vitest";
import {
  ActionAttributionSchema,
  AuthorizationDenialAuditPayloadSchema,
  CanonicalCommandEnvelopeSchema,
  RuntimeKindSchema,
  SafeNamespacedIdentifierSchema,
  TrustedCommandContextSchema,
  TypeRegistrationSchema,
  TypedRecordEnvelopeSchema
} from "@openclaw-control-plane/contracts";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const digest = "a".repeat(64);
const commandDigest = `sha256:${digest}`;

describe("runtime contracts", () => {
  it("keeps denied tool invocation provenance optional and bounded", () => {
    const base = {
      request_id: "request-1",
      decision_id: "decision-1",
      policy_version: "policy-v1",
      reason_codes: ["policy.no_matching_grant"]
    };

    expect(AuthorizationDenialAuditPayloadSchema.parse(base)).toEqual(base);
    expect(
      AuthorizationDenialAuditPayloadSchema.parse({
        ...base,
        tool_invocation_id: "tool-invocation-1"
      })
    ).toEqual({ ...base, tool_invocation_id: "tool-invocation-1" });
    expect(() =>
      AuthorizationDenialAuditPayloadSchema.parse({ ...base, tool_invocation_id: "invalid id" })
    ).toThrow();
  });

  it("keeps record, operation, subject, result, and artifact types independent", () => {
    const record = TypedRecordEnvelopeSchema.parse({
      id: firstId,
      kind: "work_item",
      type: "example.work.reconcile",
      schema_version: 1,
      schema_ref: "example://schemas/work/reconcile/v1",
      stream_id: "example-stream",
      record_sequence: 1,
      subject: { type: "example.environment", id: "production" },
      payload: { desired_state: "ready" },
      created_at: "2026-08-23T12:00:00.000Z"
    });
    const command = CanonicalCommandEnvelopeSchema.parse({
      canonicalization_version: "jcs-rfc8785-v1",
      operation_type: "example.operation.reconcile",
      operation_schema_version: 3,
      work_item_id: firstId,
      action_revision: 2,
      target: { type: "example.deployment", id: "production" },
      arguments: { mode: "safe" },
      declared_effects: [
        {
          result_type: "example.result.reconciliation",
          schema_version: 4,
          schema_ref: "example://schemas/results/reconciliation/v4",
          target: { type: "example.report", id: "reconciliation-42" },
          payload: { changed: true }
        },
        {
          result_type: "example.artifact.report",
          schema_version: 1,
          schema_ref: "example://schemas/artifacts/report/v1",
          target: { type: "example.document", id: "report-42" },
          payload: { media_type: "application/json" }
        }
      ]
    });

    expect(record.kind).toBe("work_item");
    expect(record.type).toBe("example.work.reconcile");
    expect(record.subject.type).toBe("example.environment");
    expect(command.operation_type).toBe("example.operation.reconcile");
    expect(command.declared_effects.map((effect) => effect.result_type)).toEqual([
      "example.result.reconciliation",
      "example.artifact.report"
    ]);
  });

  it("accepts only known runtime kinds and safe namespaced identifiers", () => {
    expect(RuntimeKindSchema.safeParse("event").success).toBe(true);
    expect(RuntimeKindSchema.safeParse("task").success).toBe(false);

    for (const unsafe of [
      "reconcile",
      "Example.reconcile",
      " example.reconcile",
      "example/reconcile",
      "example..reconcile"
    ]) {
      expect(SafeNamespacedIdentifierSchema.safeParse(unsafe).success).toBe(false);
    }
  });

  it("validates a server-supplied trusted command context", () => {
    const context = TrustedCommandContextSchema.parse(trustedContext());

    expect(context.authenticated_principal_ref).toBe("principal://service/runtime");
    expect(context.effective_actor).toEqual({ type: "service", id: "runtime-api" });
    expect(context.authorization.result).toBe("allowed");

    expect(
      TrustedCommandContextSchema.safeParse({
        ...trustedContext(),
        authenticated_principal_ref: "service/runtime"
      }).success
    ).toBe(false);
    expect(
      TrustedCommandContextSchema.safeParse({
        ...trustedContext(),
        injected_role: "admin"
      }).success
    ).toBe(false);
  });

  it("rejects actor, delegation, and authorization spoof fields in payloads", () => {
    const baseRecord = {
      id: firstId,
      kind: "event",
      type: "example.event.received",
      schema_version: 1,
      schema_ref: "example://schemas/events/received/v1",
      stream_id: "example-stream",
      record_sequence: 1,
      subject: { type: "example.request", id: "request-42" },
      created_at: "2026-08-23T12:00:00.000Z"
    };

    for (const payload of [
      { actor: { type: "user", id: "admin" } },
      { on_behalf_of_principal_ref: "principal://user/admin" },
      { authorization: { result: "allowed" } },
      { command_context: trustedContext() }
    ]) {
      expect(TypedRecordEnvelopeSchema.safeParse({ ...baseRecord, payload }).success).toBe(
        false
      );
    }
  });

  it("rejects spoof fields in command arguments and declared effect payloads", () => {
    const command = {
      canonicalization_version: "jcs-rfc8785-v1",
      operation_type: "example.operation.reconcile",
      operation_schema_version: 1,
      work_item_id: firstId,
      action_revision: 1,
      target: { type: "example.environment", id: "production" },
      arguments: {},
      declared_effects: [
        {
          result_type: "example.result.reconciliation",
          schema_version: 1,
          schema_ref: "example://schemas/results/reconciliation/v1",
          target: { type: "example.environment", id: "production" },
          payload: {}
        }
      ]
    };

    expect(
      CanonicalCommandEnvelopeSchema.safeParse({
        ...command,
        arguments: { authenticated_principal_ref: "principal://user/admin" }
      }).success
    ).toBe(false);
    expect(
      CanonicalCommandEnvelopeSchema.safeParse({
        ...command,
        declared_effects: [
          {
            ...command.declared_effects[0],
            payload: { effective_actor: { type: "user", id: "admin" } }
          }
        ]
      }).success
    ).toBe(false);
  });

  it("validates registrations and complete action attribution", () => {
    expect(
      TypeRegistrationSchema.parse({
        kind: "event",
        type: "example.event.received",
        schema_version: 1,
        schema_ref: "example://schemas/events/received/v1",
        schema_digest: digest,
        payload_schema: { type: "object", additionalProperties: false },
        status: "active",
        owner: "example-owner"
      }).type
    ).toBe("example.event.received");

    const attribution = ActionAttributionSchema.parse({
      id: secondId,
      work_item_id: firstId,
      operation_type: "example.operation.reconcile",
      handler_id: "reconcile-handler",
      handler_version: 1,
      command_context: trustedContext(),
      subject: { type: "example.environment", id: "production" },
      trigger: {
        type: "event",
        ref: { kind: "event", id: firstId }
      },
      causation_ref: { kind: "event", id: firstId },
      correlation_id: "workflow-42",
      request_id: "request-42",
      tool_invocation_id: "tool-call-42",
      canonicalization_version: "jcs-rfc8785-v1",
      input_refs: [{ kind: "event", id: firstId }],
      command_digest: commandDigest,
      started_at: "2026-08-23T12:00:00.000Z",
      finished_at: "2026-08-23T12:00:01.000Z",
      outcome: "succeeded",
      result_refs: [{ kind: "result", id: secondId }]
    });

    expect(attribution.command_context.authorization.decision_id).toBe("decision-42");
    expect(attribution.result_refs).toEqual([{ kind: "result", id: secondId }]);
  });
});

function trustedContext() {
  return {
    authenticated_principal_ref: "principal://service/runtime",
    effective_actor: { type: "service", id: "runtime-api" },
    on_behalf_of_principal_ref: "principal://organization/example",
    request_origin: "http",
    authorization: {
      decision_id: "decision-42",
      action: "example.action.reconcile",
      result: "allowed",
      policy_version: "policy-v1",
      reason_codes: ["example.policy.allowed"]
    }
  } as const;
}
