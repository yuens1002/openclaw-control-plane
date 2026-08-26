import { createRequire } from "node:module";

import {
  createClientCredentialsTokenProvider,
  createDecisionRuntimeMcpModule,
  createWorkloadJwtTokenProvider
} from "@openclaw-control-plane/decision-runtime-mcp";
import { createMcpServiceHost } from "@openclaw-control-plane/mcp-service";

import { loadMcpAppConfig, type McpAppConfig } from "./config.js";

export * from "./config.js";

const rootPackage = createRequire(import.meta.url)("../../../package.json") as { version: string };

export const CONTROL_PLANE_VERSION = rootPackage.version;

export async function startMcpApp(config: McpAppConfig = loadMcpAppConfig(process.env)) {
  const tokenProvider =
    config.token.mode === "workload-jwt"
      ? createWorkloadJwtTokenProvider(config.token.config)
      : createClientCredentialsTokenProvider(config.token.config);
  const decisionRuntime = createDecisionRuntimeMcpModule({
    runtimeBaseUrl: config.runtime.baseUrl,
    tokenProvider,
    allowInsecureTransport: config.runtime.allowInsecureTransport,
    requestTimeoutMs: config.runtime.requestTimeoutMs
  });
  const host = createMcpServiceHost({
    name: "openclaw-control-plane",
    version: CONTROL_PLANE_VERSION,
    modules: [decisionRuntime]
  });
  const running =
    config.mode === "stdio"
      ? await host.startStdio()
      : await host.startHttp({
          hostname: config.hosted.hostname,
          port: config.hosted.port,
          bearerToken: config.hosted.bearerToken!,
          allowedOrigins: config.hosted.allowedOrigins
        });
  let closed = false;
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      await running.close();
      await host.close();
    }
  };
}
