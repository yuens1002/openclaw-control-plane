// LIVE-INSTANCE TIER: restart-or-redeploy-triggering
// See docs/live-instance-operations.md for what this tier permits.
//
// Highest tier in this file comes from `writeRailwayVariable` with
// `skipDeploys: false`, which lets a variable write trigger a real
// redeploy of a live service. The readers below are read tier but are
// credential-bearing on the other axis: they return raw secret values.
// These calls go through the injected runner directly, not through
// guard-cli.ts's checkGuard, which only wraps a direct human invocation.
// That was gap G4 (issue #45); closed by narrowing rather than by
// building a shared guard here -- both `service` being a required
// parameter and the runner never echoing captured stdout already meet
// this row's actual requirements. See docs/live-instance-operations.md
// §7 for the full disposition.

import type { RailwayRunner } from "./index.js";

// Confirmed locally against the Railway CLI (5.40.0): `railway variable
// list --service <service> --json` returns a flat `{ [key: string]: string }`
// object of raw variable values. Every function here treats those values as
// secret-shaped: never log, print, or persist what this module returns.

export interface RailwayVariableReaderDependencies {
  runner: RailwayRunner;
}

// LIVE-INSTANCE TIER: read
export async function listRailwayVariables(
  service: string,
  dependencies: RailwayVariableReaderDependencies
): Promise<Record<string, string>> {
  const result = await dependencies.runner.run(["variable", "list", "--service", service, "--json"]);
  return JSON.parse(result.stdout) as Record<string, string>;
}

// LIVE-INSTANCE TIER: read
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

// LIVE-INSTANCE TIER: unconditional-write (restart-or-redeploy-triggering when skipDeploys is false)
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
