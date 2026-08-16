import type { RailwayRunner } from "./index.js";

// Confirmed locally against the Railway CLI (5.40.0): `railway variable
// list --service <service> --json` returns a flat `{ [key: string]: string }`
// object of raw variable values. Every function here treats those values as
// secret-shaped: never log, print, or persist what this module returns.

export interface RailwayVariableReaderDependencies {
  runner: RailwayRunner;
}

export async function listRailwayVariables(
  service: string,
  dependencies: RailwayVariableReaderDependencies
): Promise<Record<string, string>> {
  const result = await dependencies.runner.run(["variable", "list", "--service", service, "--json"]);
  return JSON.parse(result.stdout) as Record<string, string>;
}

export async function readRailwayVariable(
  name: string,
  service: string,
  dependencies: RailwayVariableReaderDependencies
): Promise<string | undefined> {
  const variables = await listRailwayVariables(service, dependencies);
  return variables[name];
}

export interface WriteRailwayVariableOptions {
  name: string;
  value: string;
  service: string;
  /**
   * Defaults to true (`--skip-deploys`). Most values feed the
   * `/setup/api/run` payload directly, so the running instance never needs
   * to see them as real process env vars. The one exception is
   * `customProviderApiKeyEnv`, which names an env var the *running OpenClaw
   * process* must resolve itself — that write must trigger a real redeploy,
   * so the caller passes `skipDeploys: false`.
   */
  skipDeploys?: boolean;
}

/**
 * Writes a single Railway variable. The value is piped via `--stdin`,
 * never included in `args`, so it never lands in a process listing or
 * shell history. Never log, print, or return what was written.
 */
export async function writeRailwayVariable(
  options: WriteRailwayVariableOptions,
  dependencies: RailwayVariableReaderDependencies
): Promise<void> {
  const skipDeploys = options.skipDeploys ?? true;
  const args = ["variable", "set", options.name, "--service", options.service];
  if (skipDeploys) {
    args.push("--skip-deploys");
  }
  args.push("--stdin", "--json");
  await dependencies.runner.run(args, options.value);
}
