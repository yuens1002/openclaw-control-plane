import { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { HTTPException } from "hono/http-exception";
import type { MiddlewareHandler } from "hono";
import {
  EventEnvelopeSchema,
  DomainSchema,
  type PipelineState,
  type TrustedCommandContext
} from "@openclaw-control-plane/contracts";
import {
  InMemoryEventStore,
  type EventStore,
  type RuntimeReadiness
} from "@openclaw-control-plane/db";

export interface ControlPlaneDependencies {
  eventStore: EventStore;
  readiness?: () => Promise<RuntimeReadiness>;
  eventCommandContext?: () => TrustedCommandContext | Promise<TrustedCommandContext>;
}

export function createControlPlaneApp(
  dependencies: ControlPlaneDependencies = { eventStore: new InMemoryEventStore() }
) {
  const app = new Hono<{
    Variables: { trustedCommandContext: TrustedCommandContext };
  }>();

  app.get("/health", async (context) => {
    const readiness = dependencies.readiness
      ? await dependencies.readiness()
      : { database: "unavailable", migrations: "missing", registry: "invalid" } as const;
    const ready =
      readiness.database === "ready" &&
      readiness.migrations === "ready" &&
      readiness.registry === "ready";
    return context.json({
      ok: ready,
      service: "openclaw-control-plane-api",
      ready,
      database: readiness.database,
      migrations: readiness.migrations,
      registry: readiness.registry,
      worker_registry: [],
      failed_runs: 0,
      stale_workers: []
    }, ready ? 200 : 503);
  });

  const operatorAuth = createOperatorAuthMiddleware();
  if (operatorAuth) {
    app.use("*", operatorAuth);
  }

  app.use("*", async (context, next) => {
    if (context.req.method !== "POST") {
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

  return app;
}

function createOperatorAuthMiddleware(): MiddlewareHandler | null {
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

export type ControlPlaneApp = ReturnType<typeof createControlPlaneApp>;
