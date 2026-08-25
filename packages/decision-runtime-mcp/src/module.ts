import {
  RuntimeApprovalRequestSchema,
  RuntimeApprovalResponseSchema,
  RuntimeCommandRequestSchema,
  RuntimeEdgesResponseSchema,
  RuntimeIntakeRequestSchema,
  RuntimeIntakeResponseSchema,
  RuntimeOperationResponseSchema,
  RuntimeProjectionResponseSchema,
  RuntimeRecordPageResponseSchema,
  RuntimeRecordQuerySchema,
  RuntimeRecordResponseSchema,
  RuntimeRegistrationCatalogSchema,
  SafeLocalIdentifierSchema,
  SafeNamespacedIdentifierSchema
} from "@openclaw-control-plane/contracts";
import {
  McpServiceError,
  type McpServiceModule,
  type McpServiceTool,
  type McpToolCallContext
} from "@openclaw-control-plane/mcp-service";
import {
  ControlPlaneApiError,
  ControlPlaneTransportError,
  createOpenClawControlPlaneTools
} from "@openclaw-control-plane/openclaw-adapter";
import { z } from "zod";

import type { createClientCredentialsTokenProvider } from "./token-provider.js";

type TokenProvider = ReturnType<typeof createClientCredentialsTokenProvider>;

export interface DecisionRuntimeMcpModuleOptions {
  runtimeBaseUrl: string;
  tokenProvider: TokenProvider;
  fetchImpl?: typeof fetch;
  allowInsecureTransport?: boolean;
  requestTimeoutMs?: number;
}

const EmptyInputSchema = z.object({}).strict();
const IntakeInputSchema = RuntimeIntakeRequestSchema.omit({ kind: true });
const RecordInputSchema = z.object({ record_id: z.string().uuid() }).strict();
const StreamRecordsInputSchema = RuntimeRecordQuerySchema.extend({
  stream_id: SafeLocalIdentifierSchema
}).strict();
const AuditInputSchema = RuntimeRecordQuerySchema.pick({ cursor: true, limit: true }).strict();
const ProjectionInputSchema = z
  .object({
    projection_type: SafeNamespacedIdentifierSchema,
    subject_type: SafeNamespacedIdentifierSchema,
    subject_id: SafeLocalIdentifierSchema,
    stream_id: SafeLocalIdentifierSchema,
    projection_version: z.number().int().positive()
  })
  .strict();

const READ_ONLY = {
  readOnlyHint: true,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false
} as const;
const APPEND_ONLY = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: false,
  openWorldHint: false
} as const;
const EXECUTE = {
  readOnlyHint: false,
  idempotentHint: true,
  destructiveHint: true,
  openWorldHint: true
} as const;

export function createDecisionRuntimeMcpModule(
  options: DecisionRuntimeMcpModuleOptions
): McpServiceModule {
  const invoke = async <T>(
    context: McpToolCallContext,
    call: (tools: ReturnType<typeof createOpenClawControlPlaneTools>) => Promise<T>
  ) => {
    const createTools = () =>
      createOpenClawControlPlaneTools({
        baseUrl: options.runtimeBaseUrl,
        tokenProvider: options.tokenProvider.getToken,
        toolInvocationIdProvider: () => context.invocationId,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
        ...(options.allowInsecureTransport !== undefined
          ? { allowInsecureTransport: options.allowInsecureTransport }
          : {}),
        ...(options.requestTimeoutMs !== undefined
          ? { requestTimeoutMs: options.requestTimeoutMs }
          : {})
      });
    try {
      return await call(createTools());
    } catch (error) {
      if (error instanceof ControlPlaneApiError && error.status === 401) {
        options.tokenProvider.invalidate();
        try {
          return await call(createTools());
        } catch (retryError) {
          throw translateRuntimeError(retryError);
        }
      }
      throw translateRuntimeError(error);
    }
  };

  const tools: McpServiceTool[] = [
    {
      name: "list_runtime_registrations",
      description: "List active runtime type and operation registrations.",
      inputSchema: EmptyInputSchema,
      outputSchema: RuntimeRegistrationCatalogSchema,
      annotations: READ_ONLY,
      handler: (_input, context) =>
        invoke(context, (adapter) => adapter.list_runtime_registrations())
    },
    {
      name: "create_runtime_event",
      description: "Append a validated event to a runtime stream.",
      inputSchema: IntakeInputSchema,
      outputSchema: RuntimeIntakeResponseSchema,
      annotations: APPEND_ONLY,
      handler: (input, context) =>
        invoke(context, (adapter) => adapter.create_runtime_event(IntakeInputSchema.parse(input)))
    },
    {
      name: "create_runtime_work_item",
      description: "Append a validated work item to a runtime stream.",
      inputSchema: IntakeInputSchema,
      outputSchema: RuntimeIntakeResponseSchema,
      annotations: APPEND_ONLY,
      handler: (input, context) =>
        invoke(context, (adapter) =>
          adapter.create_runtime_work_item(IntakeInputSchema.parse(input))
        )
    },
    {
      name: "create_runtime_approval",
      description: "Record an immutable approval decision for a command revision.",
      inputSchema: RuntimeApprovalRequestSchema,
      outputSchema: RuntimeApprovalResponseSchema,
      annotations: APPEND_ONLY,
      handler: (input, context) =>
        invoke(context, (adapter) =>
          adapter.create_runtime_approval(RuntimeApprovalRequestSchema.parse(input))
        )
    },
    {
      name: "execute_runtime_command",
      description: "Execute an authorized registered runtime command.",
      inputSchema: RuntimeCommandRequestSchema,
      outputSchema: RuntimeOperationResponseSchema,
      annotations: EXECUTE,
      handler: (input, context) =>
        invoke(context, (adapter) =>
          adapter.execute_runtime_command(RuntimeCommandRequestSchema.parse(input))
        )
    },
    {
      name: "get_runtime_record",
      description: "Read one durable runtime record by ID.",
      inputSchema: RecordInputSchema,
      outputSchema: RuntimeRecordResponseSchema,
      annotations: READ_ONLY,
      handler: (input, context) => {
        const parsed = RecordInputSchema.parse(input);
        return invoke(context, (adapter) => adapter.get_runtime_record(parsed.record_id));
      }
    },
    {
      name: "get_runtime_edges",
      description: "Read ordered provenance edges for one runtime record.",
      inputSchema: RecordInputSchema,
      outputSchema: RuntimeEdgesResponseSchema,
      annotations: READ_ONLY,
      handler: (input, context) => {
        const parsed = RecordInputSchema.parse(input);
        return invoke(context, (adapter) => adapter.get_runtime_edges(parsed.record_id));
      }
    },
    {
      name: "list_runtime_stream_records",
      description: "List a bounded page of records from a runtime stream.",
      inputSchema: StreamRecordsInputSchema,
      outputSchema: RuntimeRecordPageResponseSchema,
      annotations: READ_ONLY,
      handler: (input, context) => {
        const { stream_id, ...query } = StreamRecordsInputSchema.parse(input);
        return invoke(context, (adapter) =>
          adapter.list_runtime_stream_records(stream_id, withoutUndefined(query))
        );
      }
    },
    {
      name: "list_runtime_audit",
      description: "List a bounded page of runtime authorization audit records.",
      inputSchema: AuditInputSchema,
      outputSchema: RuntimeRecordPageResponseSchema,
      annotations: READ_ONLY,
      handler: (input, context) =>
        invoke(context, (adapter) =>
          adapter.list_runtime_audit(withoutUndefined(AuditInputSchema.parse(input)))
        )
    },
    {
      name: "get_runtime_projection",
      description: "Read a versioned runtime projection for a subject and stream.",
      inputSchema: ProjectionInputSchema,
      outputSchema: RuntimeProjectionResponseSchema,
      annotations: READ_ONLY,
      handler: (input, context) => {
        const parsed = ProjectionInputSchema.parse(input);
        return invoke(context, (adapter) =>
          adapter.get_runtime_projection(
            parsed.projection_type,
            parsed.subject_type,
            parsed.subject_id,
            parsed.stream_id,
            parsed.projection_version
          )
        );
      }
    }
  ];

  return {
    id: "decision-runtime",
    tools,
    health: async () => {
      try {
        await invoke(healthContext(), (adapter) => adapter.list_runtime_registrations());
        return { ready: true };
      } catch {
        return { ready: false, detail: "upstream_unavailable" };
      }
    }
  };
}

function healthContext(): McpToolCallContext {
  return {
    invocationId: "health-check",
    moduleId: "decision-runtime",
    toolName: "list_runtime_registrations",
    transport: "streamable-http",
    startedAt: new Date().toISOString()
  };
}

function translateRuntimeError(error: unknown) {
  if (error instanceof McpServiceError) return error;
  if (error instanceof ControlPlaneApiError) {
    return new McpServiceError(
      "downstream_rejected",
      {
        status: error.status,
        ...(error.code ? { code: error.code } : {}),
        ...(error.requestId ? { request_id: error.requestId } : {})
      },
      "Runtime request was rejected."
    );
  }
  if (error instanceof ControlPlaneTransportError) {
    return new McpServiceError(
      "downstream_unavailable",
      { code: "runtime.transport_error" },
      "Runtime service is unavailable."
    );
  }
  return error;
}

function withoutUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as {
    [Key in keyof T as undefined extends T[Key] ? Key : Key]: Exclude<T[Key], undefined>;
  };
}
