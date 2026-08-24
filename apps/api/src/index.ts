import { randomUUID } from "node:crypto";

import { Hono } from "hono";
import type { Context } from "hono";
import { basicAuth } from "hono/basic-auth";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import {
  EventEnvelopeSchema,
  DomainSchema,
  RuntimeApprovalRequestSchema,
  RuntimeCommandRequestSchema,
  RuntimeIntakeRequestSchema,
  RuntimeRecordQuerySchema,
  SafeLocalIdentifierSchema,
  SafeNamespacedIdentifierSchema,
  type PipelineState,
  type TrustedCommandContext
} from "@openclaw-control-plane/contracts";
import {
  IdempotencyConflictError,
  RuntimeRequestError,
  InMemoryEventStore,
  type RuntimeApiService,
  type EventStore,
  type RuntimeReadiness
} from "@openclaw-control-plane/db";
import {
  AuthenticationError,
  type AuthenticatedPrincipal,
  type OidcAuthenticator,
  type TrustedContextCoordinator,
  type IdentityReadiness
} from "@openclaw-control-plane/runtime-auth";
import { z } from "zod";

type RuntimeApiBoundary = Pick<
  RuntimeApiService,
  | "describeOperation"
  | "listRegistrations"
  | "createIntake"
  | "createApproval"
  | "executeCommand"
  | "getRecord"
  | "listRecords"
  | "listEdges"
  | "getProjection"
  | "recordAccessDenial"
  | "recordCommandDenial"
>;

type AppEnvironment = {
  Variables: {
    authenticatedPrincipal: AuthenticatedPrincipal;
    trustedCommandContext: TrustedCommandContext;
    requestId: string;
  };
};

const RUNTIME_BODY_LIMIT_BYTES = 256 * 1024;
const DENIAL_WINDOW_MS = 60_000;
const MAX_DENIALS_PER_WINDOW = 120;

export interface ControlPlaneDependencies {
  eventStore: EventStore;
  readiness?: () => Promise<RuntimeReadiness>;
  eventCommandContext?: () => TrustedCommandContext | Promise<TrustedCommandContext>;
  runtimeApiService?: RuntimeApiBoundary;
  authenticator?: Pick<OidcAuthenticator, "authenticateBearer">;
  trustedContextCoordinator?: Pick<TrustedContextCoordinator, "authorize">;
  identityReadiness?: () => Promise<IdentityReadiness>;
}

export function createControlPlaneApp(
  dependencies: ControlPlaneDependencies = { eventStore: new InMemoryEventStore() }
) {
  const app = new Hono<AppEnvironment>();

  app.use("*", async (context, next) => {
    context.set("requestId", randomUUID());
    await next();
  });

  app.get("/health", async (context) => {
    const readiness = dependencies.readiness
      ? await dependencies.readiness()
      : { database: "unavailable", migrations: "missing", registry: "invalid" } as const;
    const identity = dependencies.identityReadiness
      ? await dependencies.identityReadiness()
      : { identity: "invalid", jwks: "unavailable" } as const;
    const persistenceReady =
      readiness.database === "ready" &&
      readiness.migrations === "ready" &&
      readiness.registry === "ready";
    const identityRequired = Boolean(dependencies.identityReadiness);
    const ready =
      persistenceReady &&
      (!identityRequired || (identity.identity === "ready" && identity.jwks === "ready"));
    return context.json({
      ok: ready,
      service: "openclaw-control-plane-api",
      ready,
      database: readiness.database,
      migrations: readiness.migrations,
      registry: readiness.registry,
      identity: identity.identity,
      jwks: identity.jwks,
      worker_registry: [],
      failed_runs: 0,
      stale_workers: []
    }, ready ? 200 : 503);
  });

  const operatorAuth = createOperatorAuthMiddleware();
  if (operatorAuth) {
    app.use("*", async (context, next) => {
      if (context.req.path.startsWith("/v1/runtime")) {
        await next();
        return;
      }
      await operatorAuth(context, next);
    });
  }

  app.use("/v1/runtime/*", async (context, next) => {
    if (!dependencies.authenticator) {
      throw new HTTPException(503, { message: "Runtime authentication is not configured." });
    }
    context.set(
      "authenticatedPrincipal",
      await dependencies.authenticator.authenticateBearer(context.req.header("authorization"))
    );
    await next();
  });
  app.use(
    "/v1/runtime/*",
    bodyLimit({
      maxSize: RUNTIME_BODY_LIMIT_BYTES,
      onError: (context) =>
        context.json(
          errorEnvelope(
            "runtime.request_too_large",
            "Request body exceeds the permitted size.",
            context.get("requestId")
          ),
          413
        )
    })
  );

  app.use("*", async (context, next) => {
    if (context.req.method !== "POST" || context.req.path.startsWith("/v1/runtime")) {
      await next();
      return;
    }
    if (!dependencies.eventCommandContext) {
      throw new HTTPException(503, {
        message: "Authenticated operational commands are not configured."
      });
    }
    context.set("trustedCommandContext", await dependencies.eventCommandContext());
    await next();
  });

  app.get("/v1/runtime/registrations", async (context) => {
    const runtime = requireRuntimeApi(dependencies);
    await authorizeRequest(context, dependencies, {
      action: "runtime.record.read",
      resource: { type: "runtime.registry", id: "active" },
      streamId: "authorization"
    });
    return context.json(runtime.listRegistrations());
  });

  app.post("/v1/runtime/events", async (context) => {
    const request = RuntimeIntakeRequestSchema.parse({
      ...(await context.req.json()),
      kind: "event"
    });
    const trusted = await authorizeRequest(context, dependencies, {
      action: "runtime.event.ingest",
      resource: request.subject,
      streamId: request.stream_id
    });
    const result = await requireRuntimeApi(dependencies).createIntake(request, trusted);
    return context.json(result, result.status === "inserted" ? 202 : 200);
  });

  app.post("/v1/runtime/work-items", async (context) => {
    const request = RuntimeIntakeRequestSchema.parse({
      ...(await context.req.json()),
      kind: "work_item"
    });
    const trusted = await authorizeRequest(context, dependencies, {
      action: "runtime.work-item.create",
      resource: request.subject,
      streamId: request.stream_id
    });
    const result = await requireRuntimeApi(dependencies).createIntake(request, trusted);
    return context.json(result, result.status === "inserted" ? 202 : 200);
  });

  app.post("/v1/runtime/approvals", async (context) => {
    const request = RuntimeApprovalRequestSchema.parse(await context.req.json());
    const trusted = await authorizeRequest(context, dependencies, {
      action: "runtime.command.approve",
      resource: request.target,
      streamId: `approval:${request.work_item_id}`
    });
    const result = await requireRuntimeApi(dependencies).createApproval(request, trusted);
    return context.json(result, result.status === "inserted" ? 201 : 200);
  });

  app.post("/v1/runtime/commands", async (context) => {
    const runtime = requireRuntimeApi(dependencies);
    const request = RuntimeCommandRequestSchema.parse(await context.req.json());
    const operation = runtime.describeOperation(
      request.operation_type,
      request.operation_schema_version
    );
    const trusted = await authorizeRequest(context, dependencies, {
      action: operation.authorization_action,
      resource: request.target,
      streamId: request.stream_id,
      operation: {
        type: request.operation_type,
        version: request.operation_schema_version
      }
    });
    const result = await runtime.executeCommand(
      request,
      trusted,
      context.get("requestId")
    );
    return context.json(result, result.status === "inserted" ? 202 : 200);
  });

  app.get("/v1/runtime/records/:recordId", async (context) => {
    const recordId = z.string().uuid().parse(context.req.param("recordId"));
    await authorizeRequest(context, dependencies, {
      action: "runtime.record.read",
      resource: { type: "runtime.record", id: recordId },
      streamId: "authorization"
    });
    const record = await requireRuntimeApi(dependencies).getRecord(recordId);
    if (!record) throw new HTTPException(404, { message: "Runtime record was not found." });
    return context.json({ record });
  });

  app.get("/v1/runtime/records/:recordId/edges", async (context) => {
    const recordId = z.string().uuid().parse(context.req.param("recordId"));
    await authorizeRequest(context, dependencies, {
      action: "runtime.record.read",
      resource: { type: "runtime.record", id: recordId },
      streamId: "authorization"
    });
    return context.json({ edges: await requireRuntimeApi(dependencies).listEdges(recordId) });
  });

  app.get("/v1/runtime/streams/:streamId/records", async (context) => {
    const streamId = SafeLocalIdentifierSchema.parse(context.req.param("streamId"));
    await authorizeRequest(context, dependencies, {
      action: "runtime.record.read",
      resource: { type: "runtime.stream", id: streamId },
      streamId
    });
    const query = parseRecordQuery(context.req.query(), { stream_id: streamId });
    return context.json(await requireRuntimeApi(dependencies).listRecords(query));
  });

  app.get("/v1/runtime/audit", async (context) => {
    await authorizeRequest(context, dependencies, {
      action: "runtime.record.read",
      resource: { type: "runtime.audit", id: "history" },
      streamId: "authorization"
    });
    const query = parseRecordQuery(context.req.query(), { kind: "audit_entry" });
    return context.json(await requireRuntimeApi(dependencies).listRecords(query));
  });

  app.get("/v1/runtime/projections/:projectionType/:subjectType/:subjectId", async (context) => {
    const projectionType = SafeNamespacedIdentifierSchema.parse(
      context.req.param("projectionType")
    );
    const subjectType = SafeNamespacedIdentifierSchema.parse(context.req.param("subjectType"));
    const subjectId = SafeLocalIdentifierSchema.parse(context.req.param("subjectId"));
    const streamId = SafeLocalIdentifierSchema.parse(context.req.query("stream_id"));
    const projectionVersion = z.coerce.number().int().positive().parse(
      context.req.query("projection_version")
    );
    await authorizeRequest(context, dependencies, {
      action: "runtime.record.read",
      resource: { type: "runtime.projection", id: `${projectionType}:${subjectId}` },
      streamId
    });
    const projection = await requireRuntimeApi(dependencies).getProjection(
      streamId,
      projectionType,
      { type: subjectType, id: subjectId },
      projectionVersion
    );
    if (!projection) throw new HTTPException(404, { message: "Projection was not found." });
    return context.json({ projection });
  });

  app.get("/", (context) =>
    context.json({
      ok: true,
      service: "openclaw-control-plane-api",
      status: "ready",
      database: "not_connected",
      worker_registry: [],
      endpoints: ["/health", "/pipelines", "/events"]
    })
  );

  app.get("/pipelines", (context) =>
    context.json({
      pipelines: []
    })
  );

  app.post("/events", async (context) => {
    const requestBody = await context.req.json();
    const parsedEvent = EventEnvelopeSchema.safeParse(requestBody);

    if (!parsedEvent.success) {
      throw new HTTPException(400, {
        message: parsedEvent.error.message
      });
    }

    const insertResult = await dependencies.eventStore.insertEventIfNew(
      parsedEvent.data,
      context.get("trustedCommandContext")
    );

    return context.json(
      {
        status: insertResult.status,
        event: insertResult.event
      },
      insertResult.status === "inserted" ? 202 : 200
    );
  });

  app.get("/pipelines/:pipeline/state", (context) => {
    const domain = DomainSchema.parse(context.req.param("pipeline"));
    const state: PipelineState = {
      domain,
      paused: false,
      active_opportunities: 0,
      followups_due_today: 0,
      blocked_items: 0,
      pending_approvals: 0,
      recent_activity: [],
      last_audit_event_at: null
    };

    return context.json(state);
  });

  app.post("/pipelines/:pipeline/run", (context) => {
    const domain = DomainSchema.parse(context.req.param("pipeline"));
    return context.json({ status: "accepted", domain }, 202);
  });

  app.post("/pipelines/:pipeline/pause", (context) => {
    const domain = DomainSchema.parse(context.req.param("pipeline"));
    return context.json({ status: "paused", domain });
  });

  app.post("/pipelines/:pipeline/resume", (context) => {
    const domain = DomainSchema.parse(context.req.param("pipeline"));
    return context.json({ status: "resumed", domain });
  });

  app.post("/runs/:runId/retry", (context) =>
    context.json({
      status: "retry_queued",
      runId: context.req.param("runId")
    })
  );

  app.post("/events/:eventId/replay", (context) =>
    context.json({
      status: "replay_queued",
      event_id: context.req.param("eventId")
    })
  );

  app.post("/artifacts/:artifactId/review", (context) =>
    context.json({
      status: "review_ready",
      artifact_id: context.req.param("artifactId"),
      evidence: [],
      confidence: null,
      proposed_next_action: null
    })
  );

  app.post("/approvals/:approvalId/approve", (context) =>
    context.json({
      status: "approved",
      approval_id: context.req.param("approvalId")
    })
  );

  app.post("/approvals/:approvalId/reject", (context) =>
    context.json({
      status: "rejected",
      approval_id: context.req.param("approvalId")
    })
  );

  app.post("/work-items/:workItemId/handoff", (context) =>
    context.json({
      status: "handed_off",
      work_item_id: context.req.param("workItemId")
    })
  );

  app.get("/state/:subjectType/:subjectId/explain", (context) =>
    context.json({
      subject: {
        type: context.req.param("subjectType"),
        id: context.req.param("subjectId")
      },
      explanation: "No audit records are connected in the M1 stub.",
      source_refs: []
    })
  );

  app.onError((error, context) => {
    const requestId = context.get("requestId") ?? randomUUID();
    if (error instanceof AuthenticationError) {
      context.header("www-authenticate", 'Bearer realm="OpenClaw Control Plane"');
      return context.json(errorEnvelope("runtime.authentication_failed", "Authentication failed.", requestId), 401);
    }
    if (error instanceof z.ZodError) {
      return context.json(errorEnvelope("runtime.invalid_request", "Request validation failed.", requestId), 400);
    }
    if (error instanceof IdempotencyConflictError) {
      return context.json(errorEnvelope("runtime.idempotency_conflict", error.message, requestId), 409);
    }
    if (error instanceof RuntimeRequestError) {
      return context.json(errorEnvelope("runtime.invalid_request", error.message, requestId), 400);
    }
    if (error instanceof HTTPException) {
      const challenge = error.getResponse().headers.get("www-authenticate");
      if (challenge) context.header("www-authenticate", challenge);
      return context.json(
        errorEnvelope(
          error.status === 404 ? "runtime.not_found" : "runtime.request_rejected",
          error.message,
          requestId
        ),
        error.status
      );
    }
    console.error("Runtime API request failed", { requestId, error });
    return context.json(
      errorEnvelope("runtime.request_failed", "Request could not be completed.", requestId),
      500
    );
  });

  return app;
}

function createOperatorAuthMiddleware(): MiddlewareHandler | null {
  if (process.env.RUNTIME_ENABLE_BASIC_AUTH !== "true") {
    return null;
  }
  const password = process.env.SETUP_PASSWORD;
  if (!password) {
    return null;
  }

  return basicAuth({
    username: process.env.OPENCLAW_SETUP_USERNAME ?? "openclaw",
    password,
    realm: "OpenClaw Control Plane"
  });
}

async function authorizeRequest(
  context: Context<AppEnvironment>,
  dependencies: ControlPlaneDependencies,
  request: {
    action: string;
    resource: { type: string; id: string };
    streamId: string;
    operation?: { type: string; version: number };
  }
): Promise<TrustedCommandContext> {
  if (!dependencies.authenticator || !dependencies.trustedContextCoordinator) {
    throw new HTTPException(503, { message: "Runtime authentication is not configured." });
  }
  const authenticated = context.get("authenticatedPrincipal") ??
    await dependencies.authenticator.authenticateBearer(context.req.header("authorization"));
  if (!authorizationLimiter.consume(authenticated.principal.principal_id)) {
    throw new HTTPException(429, { message: "Authorization request rate limit exceeded." });
  }
  const onBehalfOf = context.req.header("x-on-behalf-of-principal");
  if (onBehalfOf && !/^principal:\/\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(onBehalfOf)) {
    throw new z.ZodError([
      { code: "custom", path: ["x-on-behalf-of-principal"], message: "Invalid principal reference." }
    ]);
  }
  const trusted = dependencies.trustedContextCoordinator.authorize({
    authenticated_principal: authenticated,
    ...(onBehalfOf ? { on_behalf_of_principal_id: onBehalfOf } : {}),
    action: request.action,
    resource: request.resource,
    request_origin: "http"
  });
  if (trusted.authorization.result === "denied") {
    const runtime = requireRuntimeApi(dependencies);
    if (request.operation) {
      await runtime.recordCommandDenial({
        stream_id: request.streamId,
        operation_type: request.operation.type,
        operation_schema_version: request.operation.version,
        target: request.resource,
        request_id: context.get("requestId"),
        command_context: trusted
      });
    } else {
      await runtime.recordAccessDenial({
        stream_id: request.streamId,
        target: request.resource,
        request_id: context.get("requestId"),
        command_context: trusted
      });
    }
    throw new HTTPException(403, { message: "Request is not authorized." });
  }
  return trusted;
}

function requireRuntimeApi(dependencies: ControlPlaneDependencies): RuntimeApiBoundary {
  if (!dependencies.runtimeApiService) {
    throw new HTTPException(503, { message: "Typed runtime API is not configured." });
  }
  return dependencies.runtimeApiService;
}

function parseRecordQuery(
  query: Record<string, string>,
  fixed: { stream_id?: string; kind?: "audit_entry" }
) {
  return RuntimeRecordQuerySchema.parse({
    ...fixed,
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.type ? { type: query.type } : {}),
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.limit ? { limit: Number(query.limit) } : {})
  });
}

function errorEnvelope(code: string, message: string, requestId: string) {
  return { error: { code, message, request_id: requestId } };
}

class AuthorizationRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  consume(principalId: string, now = Date.now()): boolean {
    const current = this.windows.get(principalId);
    if (!current || now - current.startedAt >= DENIAL_WINDOW_MS) {
      this.windows.set(principalId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= MAX_DENIALS_PER_WINDOW) return false;
    current.count += 1;
    return true;
  }
}

const authorizationLimiter = new AuthorizationRateLimiter();

export type ControlPlaneApp = ReturnType<typeof createControlPlaneApp>;
