import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

export type McpTransportKind = "stdio" | "streamable-http";

export interface McpToolCallContext {
  invocationId: string;
  moduleId: string;
  toolName: string;
  transport: McpTransportKind;
  startedAt: string;
}

export interface McpServiceTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
  outputSchema?: z.ZodType<Record<string, unknown>>;
  annotations: ToolAnnotations;
  handler: (
    input: Record<string, unknown>,
    context: McpToolCallContext
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
}

export interface McpServiceModule {
  id: string;
  tools: readonly McpServiceTool[];
  health?: () =>
    | { ready: boolean; detail?: string }
    | Promise<{ ready: boolean; detail?: string }>;
  close?: () => void | Promise<void>;
}

export interface McpServiceHostOptions {
  name: string;
  version: string;
  modules: readonly McpServiceModule[];
  createInvocationId?: () => string;
  now?: () => Date;
  onDiagnostic?: (message: string) => void;
}

export interface HostedMcpOptions {
  hostname?: string;
  port: number;
  bearerToken: string;
  mcpPath?: string;
  healthPath?: string;
  maxBodyBytes?: number;
}

export interface RunningMcpService {
  close: () => Promise<void>;
}

export interface RunningHostedMcpService extends RunningMcpService {
  server: HttpServer;
  address: () => { address: string; port: number } | null;
}

export class McpServiceError extends Error {
  constructor(
    readonly classification: string,
    readonly details: Record<string, string | number>,
    message = "Tool execution failed."
  ) {
    super(message);
    this.name = "McpServiceError";
  }
}

export function createMcpServiceHost(options: McpServiceHostOptions) {
  const tools = collectTools(options.modules);
  const invocationId = options.createInvocationId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  const diagnose = options.onDiagnostic ?? ((message: string) => process.stderr.write(`${message}\n`));
  let closed = false;

  function buildServer(transport: McpTransportKind) {
    if (closed) throw new Error("MCP service host is closed.");
    const server = new McpServer({ name: options.name, version: options.version });
    for (const { module, tool } of tools) {
      server.registerTool(
        tool.name,
        {
          ...(tool.title ? { title: tool.title } : {}),
          description: tool.description,
          inputSchema: tool.inputSchema,
          ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
          annotations: tool.annotations
        },
        async (input) => {
          const context: McpToolCallContext = {
            invocationId: invocationId(),
            moduleId: module.id,
            toolName: tool.name,
            transport,
            startedAt: now().toISOString()
          };
          try {
            const value = await tool.handler(input as Record<string, unknown>, context);
            const parsed = tool.outputSchema ? tool.outputSchema.parse(value) : value;
            return {
              structuredContent: parsed,
              content: [{ type: "text" as const, text: JSON.stringify(parsed) }]
            };
          } catch (error) {
            diagnose(`${tool.name} failed: ${classifyError(error)}`);
            return {
              isError: true,
              content: [{ type: "text" as const, text: publicError(error) }]
            };
          }
        }
      );
    }
    return server;
  }

  async function startStdio(): Promise<RunningMcpService> {
    const server = buildServer("stdio");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    let stopped = false;
    return {
      close: async () => {
        if (stopped) return;
        stopped = true;
        await server.close();
      }
    };
  }

  async function startHttp(config: HostedMcpOptions): Promise<RunningHostedMcpService> {
    if (!config.bearerToken.trim()) throw new Error("Hosted MCP bearer token is required.");
    const mcpPath = config.mcpPath ?? "/mcp";
    const healthPath = config.healthPath ?? "/health";
    const active = new Set<McpServer>();
    const httpServer = createServer(async (request, response) => {
      try {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        if (path === healthPath && request.method === "GET") {
          const health = await getHealth(options.modules);
          response.writeHead(health.ready ? 200 : 503, { "content-type": "application/json" });
          response.end(JSON.stringify(health));
          return;
        }
        if (path !== mcpPath) {
          response.writeHead(404).end();
          return;
        }
        if (!hasBearer(request, config.bearerToken)) {
          response.writeHead(401, {
            "content-type": "application/json",
            "www-authenticate": "Bearer"
          });
          response.end(JSON.stringify({ error: "unauthorized" }));
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405, { allow: "POST" }).end();
          return;
        }
        const body = await readJsonBody(request, config.maxBodyBytes ?? 1024 * 1024);
        const server = buildServer("streamable-http");
        // The SDK's no-argument constructor is stateless. Its declaration is not
        // exactOptionalPropertyTypes-compatible, so keep the cast at this boundary.
        const transport = new StreamableHTTPServerTransport();
        active.add(server);
        await server.connect(transport as unknown as Transport);
        await transport.handleRequest(request, response, body);
        response.once("close", () => {
          active.delete(server);
          void server.close();
        });
      } catch (error) {
        diagnose(`MCP HTTP request failed: ${classifyError(error)}`);
        if (!response.headersSent) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_request" }));
        } else if (!response.writableEnded) {
          response.end();
        }
      }
    });
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(config.port, config.hostname ?? "127.0.0.1", resolve);
    });
    let stopped = false;
    return {
      server: httpServer,
      address: () => {
        const address = httpServer.address();
        return address && typeof address !== "string"
          ? { address: address.address, port: address.port }
          : null;
      },
      close: async () => {
        if (stopped) return;
        stopped = true;
        await Promise.all([...active].map((server) => server.close()));
        await new Promise<void>((resolve, reject) =>
          httpServer.close((error) => (error ? reject(error) : resolve()))
        );
      }
    };
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.all(options.modules.map((module) => module.close?.()));
  }

  return { buildServer, startStdio, startHttp, close };
}

function collectTools(modules: readonly McpServiceModule[]) {
  const names = new Set<string>();
  const collected: Array<{ module: McpServiceModule; tool: McpServiceTool }> = [];
  for (const module of modules) {
    if (!module.id.trim()) throw new Error("MCP module ID is required.");
    for (const tool of module.tools) {
      if (names.has(tool.name)) throw new Error(`Duplicate MCP tool name: ${tool.name}`);
      names.add(tool.name);
      collected.push({ module, tool });
    }
  }
  return collected.sort((left, right) => left.tool.name.localeCompare(right.tool.name));
}

async function getHealth(modules: readonly McpServiceModule[]) {
  const dimensions: Record<string, { ready: boolean; detail?: string }> = {};
  for (const module of modules) {
    try {
      dimensions[module.id] = module.health ? await module.health() : { ready: true };
    } catch {
      dimensions[module.id] = { ready: false, detail: "probe_failed" };
    }
  }
  return {
    ready: Object.values(dimensions).every((dimension) => dimension.ready),
    dimensions
  };
}

function hasBearer(request: IncomingMessage, expected: string) {
  const authorization = request.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

async function readJsonBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error("Request body exceeds configured limit.");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as unknown) : undefined;
}

function classifyError(error: unknown) {
  if (error instanceof McpServiceError) return error.classification;
  if (error instanceof z.ZodError) return "validation_error";
  if (error instanceof Error && /returned 4\d\d/.test(error.message)) return "downstream_rejected";
  if (error instanceof Error && /returned 5\d\d/.test(error.message)) return "downstream_unavailable";
  return "internal_error";
}

function publicError(error: unknown) {
  if (error instanceof McpServiceError) {
    return JSON.stringify({ error: { message: error.message, ...error.details } });
  }
  if (error instanceof z.ZodError) return "Tool input or output failed validation.";
  if (error instanceof Error && /returned 4\d\d/.test(error.message)) return "Downstream request was rejected.";
  if (error instanceof Error && /returned 5\d\d/.test(error.message)) return "Downstream service is unavailable.";
  return "Tool execution failed.";
}
