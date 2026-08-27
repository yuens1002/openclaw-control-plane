import { randomUUID } from "node:crypto";

import { createControlPlaneApp } from "@openclaw-control-plane/api";
import { initializePostgresRuntime, type PostgresRuntime } from "@openclaw-control-plane/db";
import { createOpenClawControlPlaneTools } from "@openclaw-control-plane/openclaw-adapter";
import {
  AuthenticationError,
  StaticRbacAuthorizationProvider,
  TrustedContextCoordinator,
  exampleRuntimeAuthConfiguration,
  type AuthenticatedPrincipal
} from "@openclaw-control-plane/runtime-auth";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  describePostgres,
  postgresTestConnectionString as connectionString
} from "./postgres-test-helpers.js";

describePostgres("authenticated runtime HTTP PostgreSQL conformance", () => {
  const databaseName = `runtime_http_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString });
  const databaseUrl = new URL(connectionString);
  databaseUrl.pathname = `/${databaseName}`;
  let runtime: PostgresRuntime;

  beforeAll(async () => {
    await admin.query(`CREATE DATABASE ${databaseName}`);
    runtime = await initializePostgresRuntime(databaseUrl.toString());
  });

  afterAll(async () => {
    await runtime?.close();
    await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1", [
      databaseName
    ]);
    await admin.query(`DROP DATABASE IF EXISTS ${databaseName}`);
    await admin.end();
  });

  it("executes, replays, traverses, projects, audits, and preserves tool attribution", async () => {
    const app = authenticatedApp(runtime);
    const eventId = "00000000-0000-4000-8000-000000008001";
    const workId = "00000000-0000-4000-8000-000000008002";
    const headers = bearerHeaders();

    expect((await app.request("/v1/runtime/registrations", { headers })).status).toBe(200);

    expect((await app.request("/v1/runtime/events", {
      method: "POST",
      headers,
      body: JSON.stringify({
        record_id: eventId,
        stream_id: "http-stream",
        type: "example.observation",
        schema_version: 1,
        subject: target(),
        payload: { statement: "HTTP observation." },
        source_refs: []
      })
    })).status).toBe(202);
    expect((await app.request("/v1/runtime/work-items", {
      method: "POST",
      headers,
      body: JSON.stringify({
        record_id: workId,
        stream_id: "http-stream",
        type: "example.state.reconcile",
        schema_version: 1,
        subject: target(),
        payload: { requested_state: { ready: true } },
        source_refs: [{ kind: "event", id: eventId }]
      })
    })).status).toBe(202);

    const command = commandRequest(workId);
    const inserted = await app.request("/v1/runtime/commands", {
      method: "POST",
      headers: { ...headers, "x-tool-invocation-id": "tool-http-1" },
      body: JSON.stringify(command)
    });
    const insertedBody = await inserted.json() as {
      operation_record_id: string;
      result_record_ids: string[];
    };
    expect(inserted.status).toBe(202);
    expect((await app.request("/v1/runtime/commands", {
      method: "POST",
      headers,
      body: JSON.stringify(command)
    })).status).toBe(200);
    expect((await app.request("/v1/runtime/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...command, arguments: { desired: { ready: false } } })
    })).status).toBe(409);

    await runtime.repository.rebuildProjection({
      stream_id: "http-stream",
      projection_type: "example.current",
      subject: target(),
      projection_version: 1,
      input_types: [
        { kind: "result", type: "example.reconciliation.delta", schema_version: 1 }
      ],
      initial_state: { changed: false },
      reduce: (_state, record) => record.payload
    });

    const recordResponse = await app.request(
      `/v1/runtime/records/${insertedBody.operation_record_id}`,
      { headers }
    );
    const recordBody = await recordResponse.json() as {
      record: { payload: Record<string, unknown>; command_context: { request_origin: string } };
    };
    expect(recordBody.record.payload).toMatchObject({ tool_invocation_id: "tool-http-1" });
    expect(recordBody.record.command_context.request_origin).toBe("tool");
    expect((await app.request(
      `/v1/runtime/records/${insertedBody.operation_record_id}/edges`,
      { headers }
    )).status).toBe(200);
    expect((await app.request("/v1/runtime/streams/http-stream/records?limit=2", {
      headers
    })).status).toBe(200);
    expect((await app.request(
      "/v1/runtime/projections/example.current/example.environment/production?stream_id=http-stream&projection_version=1",
      { headers }
    )).status).toBe(200);
    const audit = await app.request("/v1/runtime/audit", { headers });
    expect(audit.status).toBe(200);
    expect((await audit.json()) as { records: unknown[] }).toMatchObject({ records: [{}] });
    expect(insertedBody.result_record_ids).toHaveLength(1);
  });

  it("records and consumes an immutable approval through HTTP", async () => {
    const app = authenticatedApp(runtime);
    const workId = "00000000-0000-4000-8000-000000008102";
    const headers = bearerHeaders();
    await app.request("/v1/runtime/work-items", {
      method: "POST",
      headers,
      body: JSON.stringify({
        record_id: workId,
        stream_id: "approval-http-stream",
        type: "example.state.reconcile",
        schema_version: 1,
        subject: target(),
        payload: { requested_state: {} },
        source_refs: []
      })
    });
    const command = {
      ...commandRequest(workId),
      stream_id: "approval-http-stream",
      idempotency_key: "approval-command-1",
      operation_type: "example.state.reconcile_with_approval"
    };
    const invalidApproval = await app.request("/v1/runtime/approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation_type: command.operation_type,
        operation_schema_version: command.operation_schema_version,
        work_item_id: command.work_item_id,
        action_revision: command.action_revision,
        target: command.target,
        arguments: command.arguments,
        declared_effects: command.declared_effects.map((effect) => ({
          ...effect,
          schema_ref: "example://schemas/wrong/v1"
        })),
        decision: "approved"
      })
    });
    expect(invalidApproval.status).toBe(400);
    expect(await runtime.repository.listStreamRecords(`approval:${workId}`)).toHaveLength(0);

    const approval = await app.request("/v1/runtime/approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation_type: command.operation_type,
        operation_schema_version: command.operation_schema_version,
        work_item_id: command.work_item_id,
        action_revision: command.action_revision,
        target: command.target,
        arguments: command.arguments,
        declared_effects: command.declared_effects,
        decision: "approved"
      })
    });
    const approvalBody = await approval.json() as { approval_id: string };
    const execution = await app.request("/v1/runtime/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({ ...command, approval_id: approvalBody.approval_id })
    });

    expect(approval.status).toBe(201);
    expect(execution.status).toBe(202);

    const before = await runtime.repository.listStreamRecords("approval-http-stream");
    const mutations = [
      { target: { type: "example.environment", id: "staging" } },
      { arguments: { desired: { ready: false } } },
      {
        declared_effects: command.declared_effects.map((effect) => ({
          ...effect,
          payload: { changed: false }
        }))
      },
      { action_revision: 2 },
      { approval_id: "00000000-0000-4000-8000-000000008199" },
      { executor: "principal://example/other" }
    ];
    for (const [index, mutation] of mutations.entries()) {
      const response = await app.request("/v1/runtime/commands", {
        method: "POST",
        headers,
        body: JSON.stringify({
          ...command,
          approval_id: approvalBody.approval_id,
          idempotency_key: `approval-mutation-${index}`,
          ...mutation
        })
      });
      expect(response.status, JSON.stringify(mutation)).toBe(400);
    }
    expect(await runtime.repository.listStreamRecords("approval-http-stream")).toHaveLength(
      before.length
    );

    const rejected = await app.request("/v1/runtime/approvals", {
      method: "POST",
      headers,
      body: JSON.stringify({
        operation_type: command.operation_type,
        operation_schema_version: command.operation_schema_version,
        work_item_id: command.work_item_id,
        action_revision: command.action_revision,
        target: command.target,
        arguments: command.arguments,
        declared_effects: command.declared_effects,
        decision: "rejected"
      })
    });
    const rejectedBody = await rejected.json() as { approval_id: string };
    const rejectedRecord = await app.request(`/v1/runtime/records/${rejectedBody.approval_id}`, {
      headers
    });
    expect(rejected.status).toBe(201);
    expect(await rejectedRecord.json()).toMatchObject({
      record: { kind: "approval", payload: { decision: "rejected" } }
    });
    expect((await app.request("/v1/runtime/commands", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...command,
        approval_id: rejectedBody.approval_id,
        idempotency_key: "rejected-approval-command"
      })
    })).status).toBe(400);
  });

  it("preserves artifact attribution through authenticated HTTP tool calls", async () => {
    const app = authenticatedApp(runtime);
    const workId = "00000000-0000-4000-8000-000000008202";
    await app.request("/v1/runtime/work-items", {
      method: "POST",
      headers: bearerHeaders(),
      body: JSON.stringify({
        record_id: workId,
        stream_id: "artifact-http-stream",
        type: "example.state.reconcile",
        schema_version: 1,
        subject: target(),
        payload: {},
        source_refs: []
      })
    });
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://runtime.example",
      tokenProvider: () => "valid",
      toolInvocationIdProvider: () => "artifact-tool-1",
      fetchImpl: async (input, init) => app.request(String(input), init)
    });
    const execution = await tools.execute_runtime_command({
      ...commandRequest(workId),
      stream_id: "artifact-http-stream",
      idempotency_key: "artifact-command-1",
      operation_type: "example.report.generate",
      arguments: { content_ref: "artifact://example/report" },
      declared_effects: [
        {
          kind: "artifact",
          result_type: "example.report",
          schema_version: 1,
          schema_ref: "example://schemas/report/v1",
          target: target(),
          payload: { content_ref: "artifact://example/report" }
        }
      ]
    });
    const artifact = await tools.get_runtime_record(execution.result_record_ids[0]!);
    const edges = await tools.get_runtime_edges(execution.operation_record_id);

    expect(artifact.record).toMatchObject({
      kind: "artifact",
      type: "example.report",
      payload: { content_ref: "artifact://example/report" },
      command_context: { request_origin: "tool" }
    });
    expect(edges.edges).toContainEqual(
      expect.objectContaining({
        relation: "produced",
        to_record_id: execution.result_record_ids[0]
      })
    );
  });

  it("authenticates every runtime route before route-specific work", async () => {
    const app = authenticatedApp(runtime);
    const routes = [
      ["GET", "/v1/runtime/registrations"],
      ["POST", "/v1/runtime/events"],
      ["POST", "/v1/runtime/work-items"],
      ["POST", "/v1/runtime/approvals"],
      ["POST", "/v1/runtime/commands"],
      ["GET", "/v1/runtime/records/00000000-0000-4000-8000-000000008001"],
      ["GET", "/v1/runtime/records/00000000-0000-4000-8000-000000008001/edges"],
      ["GET", "/v1/runtime/streams/http-stream/records"],
      ["GET", "/v1/runtime/audit"],
      [
        "GET",
        "/v1/runtime/projections/example.current/example.environment/production?stream_id=http-stream&projection_version=1"
      ]
    ] as const;

    for (const [method, path] of routes) {
      const response = await app.request(path, {
        method,
        ...(method === "POST"
          ? { headers: { "content-type": "application/json" }, body: "{not-json" }
          : {})
      });
      expect(response.status, `${method} ${path}`).toBe(401);
      const invalid = await app.request(path, {
        method,
        headers: {
          authorization: "Bearer invalid",
          ...(method === "POST" ? { "content-type": "application/json" } : {})
        },
        ...(method === "POST" ? { body: "{not-json" } : {})
      });
      expect(invalid.status, `invalid ${method} ${path}`).toBe(401);
    }
  });

  it("denies every runtime route through the authorization boundary", async () => {
    const app = authenticatedApp(runtime, true);
    const headers = bearerHeaders();
    const workId = "00000000-0000-4000-8000-000000008002";
    const command = commandRequest(workId);
    const requests = [
      ["GET", "/v1/runtime/registrations", undefined],
      ["POST", "/v1/runtime/events", {
        record_id: "00000000-0000-4000-8000-000000008901",
        stream_id: "denied-stream",
        type: "example.observation",
        schema_version: 1,
        subject: target(),
        payload: { statement: "Denied." },
        source_refs: []
      }],
      ["POST", "/v1/runtime/work-items", {
        record_id: "00000000-0000-4000-8000-000000008902",
        stream_id: "denied-stream",
        type: "example.state.reconcile",
        schema_version: 1,
        subject: target(),
        payload: {},
        source_refs: []
      }],
      ["POST", "/v1/runtime/approvals", {
        operation_type: command.operation_type,
        operation_schema_version: 1,
        work_item_id: workId,
        action_revision: 1,
        target: target(),
        arguments: command.arguments,
        declared_effects: command.declared_effects,
        decision: "approved"
      }],
      ["POST", "/v1/runtime/commands", { ...command, idempotency_key: "denied-command" }],
      ["GET", "/v1/runtime/records/00000000-0000-4000-8000-000000008001", undefined],
      ["GET", "/v1/runtime/records/00000000-0000-4000-8000-000000008001/edges", undefined],
      ["GET", "/v1/runtime/streams/http-stream/records", undefined],
      ["GET", "/v1/runtime/audit", undefined],
      [
        "GET",
        "/v1/runtime/projections/example.current/example.environment/production?stream_id=http-stream&projection_version=1",
        undefined
      ]
    ] as const;

    for (const [method, path, body] of requests) {
      const response = await app.request(path, {
        method,
        headers,
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      expect(response.status, `${method} ${path}`).toBe(403);
    }
  });

  it("persists denied tool provenance without creating an effect record", async () => {
    const app = authenticatedApp(runtime, true);
    const workId = "00000000-0000-4000-8000-000000008071";
    const toolStream = "denied-tool-stream";
    const tools = createOpenClawControlPlaneTools({
      baseUrl: "https://runtime.example",
      tokenProvider: () => "valid",
      toolInvocationIdProvider: () => "tool-denial-postgres-1",
      fetchImpl: async (input, init) => app.request(String(input), init)
    });

    await expect(
      tools.execute_runtime_command({
        ...commandRequest(workId),
        stream_id: toolStream,
        idempotency_key: "denied-tool-command",
        declared_effects: []
      })
    ).rejects.toMatchObject({ status: 403 });

    const toolPage = await runtime.apiService.listRecords({ stream_id: toolStream, limit: 20 });
    expect(toolPage.records).toHaveLength(1);
    expect(toolPage.records[0]).toMatchObject({
      kind: "audit_entry",
      type: "runtime.authorization.denied",
      command_context: {
        authenticated_principal_ref: "principal://example/service",
        effective_actor: { type: "service", id: "example-service" },
        request_origin: "tool",
        authorization: { result: "denied" }
      },
      payload: {
        request_id: expect.any(String),
        tool_invocation_id: "tool-denial-postgres-1"
      }
    });
    expect(toolPage.records.some((record) => record.kind === "action_attempt")).toBe(false);
    expect(toolPage.records.some((record) => record.kind === "result")).toBe(false);

    const httpStream = "denied-http-stream";
    const httpResponse = await app.request("/v1/runtime/commands", {
      method: "POST",
      headers: bearerHeaders(),
      body: JSON.stringify({
        ...commandRequest(workId),
        stream_id: httpStream,
        idempotency_key: "denied-http-command"
      })
    });

    expect(httpResponse.status).toBe(403);
    const httpPage = await runtime.apiService.listRecords({ stream_id: httpStream, limit: 20 });
    expect(httpPage.records).toHaveLength(1);
    expect(httpPage.records[0]!.command_context.request_origin).toBe("http");
    expect(httpPage.records[0]!.payload).not.toHaveProperty("tool_invocation_id");
  });
});

function authenticatedApp(runtime: PostgresRuntime, deny = false) {
  const config = deny
    ? {
        ...exampleRuntimeAuthConfiguration,
        principals: exampleRuntimeAuthConfiguration.principals.map((principal) => ({
          ...principal,
          roles: []
        }))
      }
    : exampleRuntimeAuthConfiguration;
  const provider = new StaticRbacAuthorizationProvider(config);
  return createControlPlaneApp({
    eventStore: runtime.eventStore,
    runtimeApiService: runtime.apiService,
    readiness: runtime.readiness,
    authenticator: {
      authenticateBearer: async (header) => {
        if (header !== "Bearer valid") throw new AuthenticationError("invalid_token");
        return authenticatedPrincipal();
      }
    },
    trustedContextCoordinator: new TrustedContextCoordinator(provider)
  });
}

function authenticatedPrincipal(): AuthenticatedPrincipal {
  return {
    issuer: "https://issuer.example",
    subject: "example-service",
    principal: exampleRuntimeAuthConfiguration.principals[0]!,
    claims: { iss: "https://issuer.example", sub: "example-service" }
  };
}

function bearerHeaders() {
  return { authorization: "Bearer valid", "content-type": "application/json" };
}

function target() {
  return { type: "example.environment", id: "production" };
}

function commandRequest(workItemId: string) {
  return {
    stream_id: "http-stream",
    idempotency_key: "http-command-1",
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: workItemId,
    action_revision: 1,
    target: target(),
    arguments: { desired: { ready: true } },
    declared_effects: [
      {
        kind: "result",
        result_type: "example.reconciliation.delta",
        schema_version: 1,
        schema_ref: "example://schemas/reconciliation-delta/v1",
        target: target(),
        payload: { changed: true }
      }
    ],
    trigger: {
      type: "user_request" as const,
      ref: { kind: "work_item" as const, id: workItemId }
    },
    causation_ref: { kind: "work_item" as const, id: workItemId },
    correlation_id: "http-correlation-1",
    input_refs: []
  };
}
