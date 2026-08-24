import { randomUUID } from "node:crypto";

import { createControlPlaneApp } from "@openclaw-control-plane/api";
import { initializePostgresRuntime, type PostgresRuntime } from "@openclaw-control-plane/db";
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
    const recordBody = await recordResponse.json() as { record: { payload: Record<string, unknown> } };
    expect(recordBody.record.payload).toMatchObject({ tool_invocation_id: "tool-http-1" });
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
    trigger: { type: "user_request", ref: { kind: "work_item", id: workItemId } },
    causation_ref: { kind: "work_item", id: workItemId },
    correlation_id: "http-correlation-1",
    input_refs: []
  };
}
