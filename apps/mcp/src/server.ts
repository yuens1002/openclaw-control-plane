import { pathToFileURL } from "node:url";

import { startMcpApp } from "./index.js";

export async function main() {
  const running = await startMcpApp();
  const shutdown = async () => {
    await running.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`MCP service failed to start: ${safeStartupError(error)}\n`);
    process.exitCode = 1;
  });
}

function safeStartupError(error: unknown) {
  if (error instanceof Error && error.name === "ZodError") return "invalid_configuration";
  return error instanceof Error ? error.message : "unknown_error";
}
