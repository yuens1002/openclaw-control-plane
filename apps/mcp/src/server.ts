import { pathToFileURL } from "node:url";

import { startMcpApp } from "./index.js";

export async function main() {
  const running = await startMcpApp();
  process.once("SIGINT", () => void shutdownMcpApp(running));
  process.once("SIGTERM", () => void shutdownMcpApp(running));
}

export async function shutdownMcpApp(running: { close(): Promise<void> }) {
  try {
    await running.close();
    process.exitCode = 0;
  } catch {
    process.stderr.write("MCP service failed to stop: shutdown_failed\n");
    process.exitCode = 1;
  }
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
