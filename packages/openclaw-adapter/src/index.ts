import type { Domain, EventEnvelope, PipelineState } from "@openclaw-control-plane/contracts";

export interface OpenClawAdapterOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function createOpenClawControlPlaneTools(options: OpenClawAdapterOptions) {
  const callApi = createApiCaller(options);

  return {
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
    const requestInit: RequestInit = { method: request.method };

    if (request.body) {
      requestInit.headers = { "content-type": "application/json" };
      requestInit.body = JSON.stringify(request.body);
    }

    const response = await fetchImpl(`${baseUrl}${path}`, requestInit);

    if (!response.ok) {
      throw new Error(`Control plane API returned ${response.status}`);
    }

    return (await response.json()) as TResponse;
  };
}
