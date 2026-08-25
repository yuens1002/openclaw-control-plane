import type {
  Domain,
  EventEnvelope,
  PipelineState,
  RuntimeApprovalRequest,
  RuntimeCommandRequest,
  RuntimeIntakeRequest
} from "@openclaw-control-plane/contracts";
import {
  RuntimeApprovalRequestSchema,
  RuntimeApprovalResponseSchema,
  RuntimeEdgesResponseSchema,
  RuntimeIntakeResponseSchema,
  RuntimeOperationResponseSchema,
  RuntimeProjectionResponseSchema,
  RuntimeRecordPageResponseSchema,
  RuntimeRecordResponseSchema,
  RuntimeRegistrationCatalogSchema,
  RuntimeCommandRequestSchema,
  RuntimeIntakeRequestSchema,
  RuntimeRecordQuerySchema,
  SafeLocalIdentifierSchema,
  SafeNamespacedIdentifierSchema
} from "@openclaw-control-plane/contracts";
import { z } from "zod";

export interface OpenClawAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => string | Promise<string>;
  toolInvocationIdProvider?: () => string | Promise<string>;
  allowInsecureTransport?: boolean;
}

export class ControlPlaneApiError extends Error {
  constructor(readonly status: number) {
    super(`Control plane API returned ${status}`);
    this.name = "ControlPlaneApiError";
  }
}

export function createOpenClawControlPlaneTools(options: OpenClawAdapterOptions) {
  const endpoint = new URL(options.baseUrl);
  if (options.tokenProvider && endpoint.protocol !== "https:" && !options.allowInsecureTransport) {
    throw new Error("Bearer-authenticated control plane tools require HTTPS.");
  }
  const callApi = createApiCaller(options);

  return {
    list_runtime_registrations: () =>
      callApi("/v1/runtime/registrations", { method: "GET" }, RuntimeRegistrationCatalogSchema),
    create_runtime_event: (input: Omit<RuntimeIntakeRequest, "kind">) =>
      callApi(
        "/v1/runtime/events",
        { method: "POST", body: intakeBody(input, "event") },
        RuntimeIntakeResponseSchema
      ),
    create_runtime_work_item: (input: Omit<RuntimeIntakeRequest, "kind">) =>
      callApi(
        "/v1/runtime/work-items",
        { method: "POST", body: intakeBody(input, "work_item") },
        RuntimeIntakeResponseSchema
      ),
    create_runtime_approval: (input: RuntimeApprovalRequest) =>
      callApi(
        "/v1/runtime/approvals",
        { method: "POST", body: RuntimeApprovalRequestSchema.parse(input) },
        RuntimeApprovalResponseSchema
      ),
    execute_runtime_command: async (input: RuntimeCommandRequest) =>
      callApi(
        "/v1/runtime/commands",
        {
          method: "POST",
          body: RuntimeCommandRequestSchema.parse(input),
          ...(options.toolInvocationIdProvider
            ? { toolInvocationId: await options.toolInvocationIdProvider() }
            : {})
        },
        RuntimeOperationResponseSchema
      ),
    get_runtime_record: (recordId: string) =>
      callApi(
        `/v1/runtime/records/${encodeURIComponent(z.string().uuid().parse(recordId))}`,
        { method: "GET" },
        RuntimeRecordResponseSchema
      ),
    get_runtime_edges: (recordId: string) =>
      callApi(
        `/v1/runtime/records/${encodeURIComponent(z.string().uuid().parse(recordId))}/edges`,
        { method: "GET" },
        RuntimeEdgesResponseSchema
      ),
    list_runtime_stream_records: (
      streamId: string,
      query: { kind?: string; type?: string; cursor?: string; limit?: number } = {}
    ) =>
      callApi(
        `/v1/runtime/streams/${encodeURIComponent(SafeLocalIdentifierSchema.parse(streamId))}/records${queryString(RuntimeRecordQuerySchema.omit({ stream_id: true }).parse(query))}`,
        { method: "GET" },
        RuntimeRecordPageResponseSchema
      ),
    list_runtime_audit: (query: { cursor?: string; limit?: number } = {}) =>
      callApi(
        `/v1/runtime/audit${queryString(RuntimeRecordQuerySchema.pick({ cursor: true, limit: true }).parse(query))}`,
        { method: "GET" },
        RuntimeRecordPageResponseSchema
      ),
    get_runtime_projection: (
      projectionType: string,
      subjectType: string,
      subjectId: string,
      streamId: string,
      projectionVersion: number
    ) =>
      callApi(
        `/v1/runtime/projections/${encodeURIComponent(SafeNamespacedIdentifierSchema.parse(projectionType))}/${encodeURIComponent(SafeNamespacedIdentifierSchema.parse(subjectType))}/${encodeURIComponent(SafeLocalIdentifierSchema.parse(subjectId))}?stream_id=${encodeURIComponent(SafeLocalIdentifierSchema.parse(streamId))}&projection_version=${z.number().int().positive().parse(projectionVersion)}`,
        { method: "GET" },
        RuntimeProjectionResponseSchema
      ),
    list_pipelines: () =>
      callApi<{
        pipelines: Array<{
          domain: Domain;
          stage: string;
          owner: string;
          health: string;
          next_scheduled_run: string | null;
          blockers: string[];
          pending_approvals: number;
        }>;
      }>("/pipelines", {
        method: "GET"
      }),
    ingest_event: (eventEnvelope: EventEnvelope) =>
      callApi<{ status: "inserted" | "duplicate"; event: EventEnvelope }>("/events", {
        method: "POST",
        body: eventEnvelope
      }),
    get_pipeline_state: (domain: Domain) =>
      callApi<PipelineState>(`/pipelines/${domain}/state`, {
        method: "GET"
      }),
    run_pipeline: (domain: Domain, input: Record<string, unknown>) =>
      callApi<{ status: "accepted"; domain: Domain }>(`/pipelines/${domain}/run`, {
        method: "POST",
        body: { input }
      }),
    pause_pipeline: (domain: Domain) =>
      callApi<{ status: "paused"; domain: Domain }>(`/pipelines/${domain}/pause`, {
        method: "POST"
      }),
    resume_pipeline: (domain: Domain) =>
      callApi<{ status: "resumed"; domain: Domain }>(`/pipelines/${domain}/resume`, {
        method: "POST"
      }),
    retry_run: (runId: string) =>
      callApi<{ status: "retry_queued"; runId: string }>(`/runs/${runId}/retry`, {
        method: "POST"
      }),
    replay_event: (eventId: string) =>
      callApi<{ status: "replay_queued"; event_id: string }>(`/events/${eventId}/replay`, {
        method: "POST"
      }),
    review_output: (artifactId: string) =>
      callApi<{ status: "review_ready"; artifact_id: string }>(`/artifacts/${artifactId}/review`, {
        method: "POST"
      }),
    approve_action: (approvalId: string) =>
      callApi<{ status: "approved"; approval_id: string }>(`/approvals/${approvalId}/approve`, {
        method: "POST"
      }),
    reject_action: (approvalId: string, reason: string) =>
      callApi<{ status: "rejected"; approval_id: string }>(`/approvals/${approvalId}/reject`, {
        method: "POST",
        body: { reason }
      }),
    handoff_work_item: (workItemId: string) =>
      callApi<{ status: "handed_off"; work_item_id: string }>(`/work-items/${workItemId}/handoff`, {
        method: "POST"
      }),
    get_health: () =>
      callApi<{ ok: boolean; service: string }>("/health", {
        method: "GET"
      }),
    explain_state: (subjectType: string, subjectId: string) =>
      callApi<{ explanation: string; source_refs: string[] }>(
        `/state/${subjectType}/${subjectId}/explain`,
        {
          method: "GET"
        }
      )
  };
}

function intakeBody(input: Omit<RuntimeIntakeRequest, "kind">, kind: "event" | "work_item") {
  const parsed = RuntimeIntakeRequestSchema.parse({ ...input, kind });
  const { kind: _kind, ...body } = parsed;
  return body;
}

function createApiCaller(options: OpenClawAdapterOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return async function callApi<TResponse = unknown>(
    path: string,
    request: { method: "GET" | "POST"; body?: unknown; toolInvocationId?: string },
    responseSchema?: z.ZodType<TResponse>
  ): Promise<TResponse> {
    const headers: Record<string, string> = {};
    if (options.tokenProvider) {
      const token = await options.tokenProvider();
      if (!token.trim()) throw new Error("Control plane token provider returned an empty token.");
      headers.authorization = `Bearer ${token}`;
    }
    if (request.toolInvocationId) {
      headers["x-tool-invocation-id"] = request.toolInvocationId;
    }
    const requestInit: RequestInit = { method: request.method, headers };

    if ("body" in request) {
      headers["content-type"] = "application/json";
      requestInit.body = JSON.stringify(request.body);
    }

    const response = await fetchImpl(`${baseUrl}${path}`, requestInit);

    if (!response.ok) {
      throw new ControlPlaneApiError(response.status);
    }

    const body = await response.json();
    return responseSchema ? responseSchema.parse(body) : (body as TResponse);
  };
}

function queryString(values: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : "";
}
