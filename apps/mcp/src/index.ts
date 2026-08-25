import {
  createClientCredentialsTokenProvider,
  createDecisionRuntimeMcpModule
} from "@openclaw-control-plane/decision-runtime-mcp";
import { createMcpServiceHost } from "@openclaw-control-plane/mcp-service";

import { loadMcpAppConfig, type McpAppConfig } from "./config.js";

export * from "./config.js";

export async function startMcpApp(config: McpAppConfig = loadMcpAppConfig(process.env)) {
  const tokenProvider = createClientCredentialsTokenProvider(config.token);
  const decisionRuntime = createDecisionRuntimeMcpModule({
    runtimeBaseUrl: config.runtime.baseUrl,
    tokenProvider,
    allowInsecureTransport: config.runtime.allowInsecureTransport,
    requestTimeoutMs: config.runtime.requestTimeoutMs
  });
  const host = createMcpServiceHost({
    name: "openclaw-control-plane",
    version: "1.0.0",
    modules: [decisionRuntime]
  });
  const running =
    config.mode === "stdio"
      ? await host.startStdio()
      : await host.startHttp({
          hostname: config.hosted.hostname,
          port: config.hosted.port,
          bearerToken: config.hosted.bearerToken!
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
