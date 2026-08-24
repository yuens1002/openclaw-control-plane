import { describe, expect, it, vi } from "vitest";

import { createControlPlaneApp, type ControlPlaneDependencies } from "@openclaw-control-plane/api";
import { exampleOperationRegistrations, type RuntimeApiService } from "@openclaw-control-plane/db";
import { RuntimeRequestError } from "@openclaw-control-plane/db";
import {
  AuthenticationError,
  StaticRbacAuthorizationProvider,
  TrustedContextCoordinator,
  exampleRuntimeAuthConfiguration,
  type AuthenticatedPrincipal
} from "@openclaw-control-plane/runtime-auth";

describe("authenticated runtime API", () => {
  it("rejects missing credentials before the runtime boundary", async () => {
    const dependencies = createDependencies();
    const response = await createControlPlaneApp(dependencies).request("/v1/runtime/registrations");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "runtime.authentication_failed", message: "Authentication failed." }
    });
    expect(dependencies.runtimeApiService!.listRegistrations).not.toHaveBeenCalled();
  });

  it("authenticates before parsing a malformed or oversized body", async () => {
    const dependencies = createDependencies();
    const unauthenticated = await createControlPlaneApp(dependencies).request(
      "/v1/runtime/events",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not-json"
      }
    );
    const oversized = await createControlPlaneApp(dependencies).request(
      "/v1/runtime/events",
      {
        method: "POST",
        headers: { authorization: "Bearer valid", "content-type": "application/json" },
        body: JSON.stringify({ padding: "x".repeat(257 * 1024) })
      }
    );

    expect(unauthenticated.status).toBe(401);
    expect(oversized.status).toBe(413);
    expect(dependencies.runtimeApiService!.createIntake).not.toHaveBeenCalled();
  });

  it("creates a typed event with server-derived context", async () => {
    const dependencies = createDependencies();
    const response = await createControlPlaneApp(dependencies).request("/v1/runtime/events", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify(eventRequest())
    });

    expect(response.status).toBe(202);
    expect(dependencies.runtimeApiService!.createIntake).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "event", type: "example.observation" }),
      expect.objectContaining({
        authenticated_principal_ref: "principal://example/service",
        authorization: expect.objectContaining({
          action: "runtime.event.ingest",
          result: "allowed"
        })
      })
    );
  });

  it("rejects trust-field spoofing before runtime execution", async () => {
    const dependencies = createDependencies();
    const response = await createControlPlaneApp(dependencies).request("/v1/runtime/events", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify({
        ...eventRequest(),
        authenticated_principal_ref: "principal://spoofed/user"
      })
    });

    expect(response.status).toBe(400);
    expect(dependencies.runtimeApiService!.createIntake).not.toHaveBeenCalled();
  });

  it("routes authorization denial through the bounded audit method", async () => {
    const dependencies = createDependencies({ deny: true });
    const response = await createControlPlaneApp(dependencies).request("/v1/runtime/registrations", {
      headers: { authorization: "Bearer valid" }
    });

    expect(response.status).toBe(403);
    expect(dependencies.runtimeApiService!.recordAccessDenial).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { type: "runtime.registry", id: "active" },
        command_context: expect.objectContaining({
          authorization: expect.objectContaining({ result: "denied" })
        })
      })
    );
    expect(dependencies.runtimeApiService!.listRegistrations).not.toHaveBeenCalled();
  });

  it("returns bounded stream pages through the authorized query boundary", async () => {
    const dependencies = createDependencies();
    const response = await createControlPlaneApp(dependencies).request(
      "/v1/runtime/streams/stream-1/records?limit=25&cursor=opaque-page-token&kind=result",
      { headers: { authorization: "Bearer valid" } }
    );

    expect(response.status).toBe(200);
    expect(dependencies.runtimeApiService!.listRecords).toHaveBeenCalledWith({
      stream_id: "stream-1",
      kind: "result",
      cursor: "opaque-page-token",
      limit: 25
    });
  });

  it("returns a stable client error for unknown or retired operation registrations", async () => {
    const dependencies = createDependencies();
    dependencies.runtimeApiService!.describeOperation = vi.fn(() => {
      throw new RuntimeRequestError();
    });
    const response = await createControlPlaneApp(dependencies).request("/v1/runtime/commands", {
      method: "POST",
      headers: { authorization: "Bearer valid", "content-type": "application/json" },
      body: JSON.stringify(commandRequest())
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "runtime.invalid_request" } });
  });
});

function createDependencies(options: { deny?: boolean } = {}) {
  const config = options.deny
    ? {
        ...exampleRuntimeAuthConfiguration,
        principals: exampleRuntimeAuthConfiguration.principals.map((principal) => ({
          ...principal,
          roles: []
        }))
      }
    : exampleRuntimeAuthConfiguration;
  const provider = new StaticRbacAuthorizationProvider(config, {
    createDecisionId: () => "decision-1"
  });
  const runtimeApiService = {
    describeOperation: vi.fn(() => exampleOperationRegistrations[0]!),
    listRegistrations: vi.fn(() => ({ types: [], operations: [] })),
    createIntake: vi.fn<RuntimeApiService["createIntake"]>(async (input, context) => ({
      status: "inserted" as const,
      record: {
        record_id: input.record_id,
        stream_id: input.stream_id,
        record_sequence: 1,
        command_context: context,
        recorded_at: "2026-08-24T12:00:00.000Z",
        kind: input.kind,
        type: input.type,
        schema_version: input.schema_version,
        schema_ref: "example://schemas/test/v1",
        subject: input.subject,
        payload: input.payload,
        occurred_at: "2026-08-24T12:00:00.000Z"
      }
    })),
    createApproval: vi.fn(),
    executeCommand: vi.fn(),
    getRecord: vi.fn(),
    listRecords: vi.fn(async () => ({ records: [], next_cursor: null })),
    listEdges: vi.fn(async () => []),
    getProjection: vi.fn(),
    recordAccessDenial: vi.fn<RuntimeApiService["recordAccessDenial"]>(async (input) => ({
      record_id: "00000000-0000-4000-8000-000000000199",
      stream_id: input.stream_id,
      record_sequence: 1,
      command_context: input.command_context,
      recorded_at: "2026-08-24T12:00:00.000Z",
      kind: "audit_entry",
      type: "runtime.authorization.denied",
      schema_version: 1,
      schema_ref: "runtime://schemas/authorization-denied/v1",
      subject: input.target,
      payload: {
        request_id: input.request_id,
        decision_id: input.command_context.authorization.decision_id,
        policy_version: input.command_context.authorization.policy_version,
        reason_codes: input.command_context.authorization.reason_codes
      },
      occurred_at: "2026-08-24T12:00:00.000Z"
    })),
    recordCommandDenial: vi.fn()
  };
  return {
    eventStore: {
      insertEventIfNew: vi.fn(),
      getEventByIdempotencyKey: vi.fn()
    },
    runtimeApiService,
    authenticator: {
      authenticateBearer: vi.fn(async (header) => {
        if (header !== "Bearer valid") throw new AuthenticationError("missing_bearer_token");
        return authenticatedPrincipal();
      })
    },
    trustedContextCoordinator: new TrustedContextCoordinator(provider)
  } satisfies ControlPlaneDependencies;
}

function authenticatedPrincipal(): AuthenticatedPrincipal {
  return {
    issuer: "https://issuer.example",
    subject: "example-service",
    principal: exampleRuntimeAuthConfiguration.principals[0]!,
    claims: { iss: "https://issuer.example", sub: "example-service" }
  };
}

function commandRequest() {
  return {
    stream_id: "stream-1",
    idempotency_key: "request-1",
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: "00000000-0000-4000-8000-000000000010",
    action_revision: 1,
    target: { type: "example.environment", id: "production" },
    arguments: { desired_state: { ready: true } },
    declared_effects: [],
    trigger: {
      type: "user_request",
      ref: { kind: "work_item", id: "00000000-0000-4000-8000-000000000010" }
    },
    causation_ref: { kind: "work_item", id: "00000000-0000-4000-8000-000000000010" },
    correlation_id: "correlation-1",
    input_refs: []
  };
}

function eventRequest() {
  return {
    record_id: "00000000-0000-4000-8000-000000000101",
    stream_id: "stream-1",
    type: "example.observation",
    schema_version: 1,
    subject: { type: "example.environment", id: "production" },
    payload: { observed: true },
    source_refs: []
  };
}
