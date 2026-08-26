import { spawn, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const servers: Server[] = [];
const children: ChildProcess[] = [];
const EXPECTED_TOOLS = [
  "create_runtime_approval",
  "create_runtime_event",
  "create_runtime_work_item",
  "execute_runtime_command",
  "get_runtime_edges",
  "get_runtime_projection",
  "get_runtime_record",
  "list_runtime_audit",
  "list_runtime_registrations",
  "list_runtime_stream_records"
];

afterEach(async () => {
  await Promise.all(children.splice(0).map(stopChild));
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("Decision Runtime MCP hosted process", () => {
  it("proves official-client calls, active readiness, restart, and degraded upstream state", async () => {
    let runtimeCalls = 0;
    const tokenServer = await listen((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ access_token: "hosted-token", token_type: "Bearer", expires_in: 60 })
      );
    });
    const runtimeServer = await listen((request, response) => {
      runtimeCalls += 1;
      expect(request.headers.authorization).toBe("Bearer hosted-token");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ types: [], operations: [] }));
    });
    const appPort = await reservePort();
    const environment = {
      NODE_ENV: "development",
      MCP_TRANSPORT: "streamable-http",
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(appPort),
      MCP_INBOUND_BEARER_TOKEN: "example-bridge-secret",
      MCP_ALLOW_INSECURE_TRANSPORT: "true",
      RUNTIME_API_URL: `http://127.0.0.1:${addressPort(runtimeServer)}`,
      OIDC_TOKEN_ENDPOINT: `http://127.0.0.1:${addressPort(tokenServer)}/token`,
      OIDC_CLIENT_ID: "example-client",
      OIDC_CLIENT_SECRET: "example-secret"
    };

    let child = startApp(environment);
    await expectHealth(appPort, 200, true);
    const client = new Client({ name: "hosted-conformance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${appPort}/mcp`),
      { requestInit: { headers: { authorization: "Bearer example-bridge-secret" } } }
    );
    await client.connect(transport as unknown as Transport);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    expect(
      listed.tools.find((tool) => tool.name === "execute_runtime_command")?.annotations
    ).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
      destructiveHint: true,
      openWorldHint: true
    });
    expect(
      (await client.callTool({ name: "list_runtime_registrations", arguments: {} }))
        .structuredContent
    ).toEqual({ types: [], operations: [] });
    await client.close();

    await stopChild(child);
    child = startApp(environment);
    await expectHealth(appPort, 200, true);
    expect(runtimeCalls).toBeGreaterThanOrEqual(3);

    await closeServer(runtimeServer);
    await expectHealth(appPort, 503, false);
    await stopChild(child);
  });

  it("reaches ready and serves runtime reads with a signed workload identity", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let verifiedSubject: string | undefined;
    const runtimeServer = await listen(async (request, response) => {
      const bearer = request.headers.authorization?.replace(/^Bearer /, "");
      if (!bearer) {
        response.writeHead(401).end();
        return;
      }
      const verified = await jwtVerify(bearer, publicKey, {
        issuer: "https://issuer.example",
        audience: "control-plane",
        algorithms: ["RS256"]
      });
      verifiedSubject = verified.payload.sub;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ types: [], operations: [] }));
    });
    const appPort = await reservePort();
    const child = startApp({
      NODE_ENV: "development",
      MCP_TRANSPORT: "streamable-http",
      MCP_HOST: "127.0.0.1",
      MCP_PORT: String(appPort),
      MCP_INBOUND_BEARER_TOKEN: "example-bridge-secret",
      MCP_ALLOW_INSECURE_TRANSPORT: "true",
      RUNTIME_API_URL: `http://127.0.0.1:${addressPort(runtimeServer)}`,
      MCP_DOWNSTREAM_AUTH_MODE: "workload-jwt",
      MCP_WORKLOAD_JWT_ISSUER: "https://issuer.example",
      MCP_WORKLOAD_JWT_SUBJECT: "example-workload",
      MCP_WORKLOAD_JWT_AUDIENCE: "control-plane",
      MCP_WORKLOAD_JWT_KEY_ID: "workload-key-1",
      MCP_WORKLOAD_JWT_ALGORITHM: "RS256",
      MCP_WORKLOAD_JWT_PRIVATE_KEY: privateKey
        .export({ format: "pem", type: "pkcs8" })
        .toString(),
      MCP_WORKLOAD_JWT_LIFETIME_SECONDS: "120"
    });

    await expectHealth(appPort, 200, true);
    const client = new Client({ name: "workload-conformance", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${appPort}/mcp`),
      { requestInit: { headers: { authorization: "Bearer example-bridge-secret" } } }
    );
    await client.connect(transport as unknown as Transport);
    await expect(
      client.callTool({ name: "list_runtime_registrations", arguments: {} })
    ).resolves.toMatchObject({ structuredContent: { types: [], operations: [] } });
    expect(verifiedSubject).toBe("example-workload");
    await client.close();
    await stopChild(child);
  });
});

function startApp(environment: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", "apps/mcp/src/server.ts"], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push(child);
  return child;
}

async function expectHealth(port: number, status: number, ready: boolean) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.status === status) {
        expect(await response.json()).toMatchObject({ ready });
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`Health did not reach HTTP ${status}.`);
}

async function reservePort() {
  const server = await listen((_request, response) => response.end());
  const port = addressPort(server);
  await closeServer(server);
  return port;
}

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server;
}

function addressPort(server: Server) {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server is not listening.");
  return address.port;
}

async function closeServer(server: Server) {
  const index = servers.indexOf(server);
  if (index >= 0) servers.splice(index, 1);
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function stopChild(child: ChildProcess) {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await exited;
}
