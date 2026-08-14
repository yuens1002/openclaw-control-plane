import type { RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";

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
