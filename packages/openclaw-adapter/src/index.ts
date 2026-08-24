import type {
  Domain,
  EventEnvelope,
  PipelineState,
  RuntimeApprovalRequest,
  RuntimeCommandRequest,
  RuntimeIntakeRequest
} from "@openclaw-control-plane/contracts";

export interface OpenClawAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  tokenProvider?: () => string | Promise<string>;
  allowInsecureTransport?: boolean;
}

export function createOpenClawControlPlaneTools(options: OpenClawAdapterOptions) {
  const endpoint = new URL(options.baseUrl);
  if (options.tokenProvider && endpoint.protocol !== "https:" && !options.allowInsecureTransport) {
    throw new Error("Bearer-authenticated control plane tools require HTTPS.");
  }
  const callApi = createApiCaller(options);

  return {
    list_runtime_registrations: () =>
      callApi<{ types: unknown[]; operations: unknown[] }>("/v1/runtime/registrations", {
        method: "GET"
      }),
    create_runtime_event: (input: Omit<RuntimeIntakeRequest, "kind">) =>
      callApi("/v1/runtime/events", { method: "POST", body: input }),
    create_runtime_work_item: (input: Omit<RuntimeIntakeRequest, "kind">) =>
      callApi("/v1/runtime/work-items", { method: "POST", body: input }),
    create_runtime_approval: (input: RuntimeApprovalRequest) =>
      callApi<{ approval_id: string; command_digest: string }>("/v1/runtime/approvals", {
        method: "POST",
        body: input
      }),
    execute_runtime_command: (input: RuntimeCommandRequest) =>
      callApi("/v1/runtime/commands", { method: "POST", body: input }),
    get_runtime_record: (recordId: string) =>
      callApi(`/v1/runtime/records/${encodeURIComponent(recordId)}`, { method: "GET" }),
    get_runtime_edges: (recordId: string) =>
      callApi(`/v1/runtime/records/${encodeURIComponent(recordId)}/edges`, { method: "GET" }),
    list_runtime_stream_records: (
      streamId: string,
      query: { kind?: string; type?: string; cursor?: string; limit?: number } = {}
    ) =>
      callApi(
        `/v1/runtime/streams/${encodeURIComponent(streamId)}/records${queryString(query)}`,
        { method: "GET" }
      ),
    list_runtime_audit: (query: { cursor?: string; limit?: number } = {}) =>
      callApi(`/v1/runtime/audit${queryString(query)}`, { method: "GET" }),
    get_runtime_projection: (
      projectionType: string,
      subjectType: string,
      subjectId: string,
      streamId: string,
      projectionVersion: number
    ) =>
      callApi(
        `/v1/runtime/projections/${encodeURIComponent(projectionType)}/${encodeURIComponent(subjectType)}/${encodeURIComponent(subjectId)}?stream_id=${encodeURIComponent(streamId)}&projection_version=${projectionVersion}`,
        { method: "GET" }
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

function createApiCaller(options: OpenClawAdapterOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  return async function callApi<TResponse>(
    path: string,
    request: { method: "GET" | "POST"; body?: unknown }
  ): Promise<TResponse> {
    const headers: Record<string, string> = {};
    if (options.tokenProvider) {
      const token = await options.tokenProvider();
      if (!token.trim()) throw new Error("Control plane token provider returned an empty token.");
      headers.authorization = `Bearer ${token}`;
    }
    const requestInit: RequestInit = { method: request.method, headers };

    if (request.body) {
      headers["content-type"] = "application/json";
      requestInit.body = JSON.stringify(request.body);
    }

    const response = await fetchImpl(`${baseUrl}${path}`, requestInit);

    if (!response.ok) {
      throw new Error(`Control plane API returned ${response.status}`);
    }

    return (await response.json()) as TResponse;
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
