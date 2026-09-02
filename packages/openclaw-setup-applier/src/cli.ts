import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyProfile, dryRunApplyProfile, printDryRunResult } from "./apply-profile.js";
import { createSetupApiClient } from "./setup-api-client.js";

import type { RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";

export interface CliOptions {
  profilePath?: string;
  service?: string;
  instanceUrl?: string;
  dryRun: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.profilePath === undefined) {
    throw new Error("Missing required argument: --profile <path>");
  }
  if (options.service === undefined) {
    throw new Error("Missing required argument: --service <name>");
  }
  if (options.instanceUrl === undefined) {
    throw new Error("Missing required argument: --instance-url <url>");
  }

  const candidateProfile = JSON.parse(await readFile(options.profilePath, "utf8")) as unknown;
  const railway = await resolveRailwayExecutable();
  const runner: RailwayRunner = {
    run: (args, stdin) => runCommand(railway, args, stdin)
  };

  if (options.dryRun) {
    const result = await dryRunApplyProfile(candidateProfile, { service: options.service }, { runner });
    printDryRunResult(result);
    return;
  }

  const openRouterManagementKey = requireEnv("OPENROUTER_MANAGEMENT_KEY");
  // OPENCLAW_INSTANCE_SETUP_PASSWORD/USERNAME are the *target OpenClaw
  // instance's* setup credentials, deliberately not named SETUP_PASSWORD/
  // OPENCLAW_SETUP_USERNAME -- an OpenClaw instance's own setup auth gate
  // reads those exact names (see the wrapper patch in this repo's Dockerfile
  // and deploy/openclaw-railway/.env.example), and this CLI can run in the
  // same environment as an instance when bootstrapping this repo's own
  // agency instance from a profile of itself. Reusing the names would make
  // the two indistinguishable. See docs/plans/setup-api-basic-auth/plan.md.
  const setupPassword = requireEnv("OPENCLAW_INSTANCE_SETUP_PASSWORD");
  const setupUsername = process.env.OPENCLAW_INSTANCE_SETUP_USERNAME ?? "openclaw";

  const setupApiClient = createSetupApiClient({
    baseUrl: options.instanceUrl,
    auth: { username: setupUsername, password: setupPassword }
  });
  const result = await applyProfile(
    candidateProfile,
    { service: options.service, instanceBaseUrl: options.instanceUrl },
    { runner, setupApiClient, openRouterManagementKey }
  );
  console.log(`Outcome: ${result.outcome}`);
}

export function parseArgs(args: string[]): CliOptions {
  const options: CliOptions = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--profile":
        options.profilePath = requireValue(arg, value);
        index += 1;
        break;
      case "--service":
        options.service = requireValue(arg, value);
        index += 1;
        break;
      case "--instance-url":
        options.instanceUrl = requireValue(arg, value);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Duplicated (not imported) from packages/openclaw-railway-installer/src/cli.ts:
// that module doesn't export these, and the duplication is a handful of
// lines versus adding new exports to another package's CLI entrypoint.
async function resolveRailwayExecutable(): Promise<string> {
  const npmGlobal = process.env.APPDATA
    ? join(process.env.APPDATA, "npm", "node_modules", "@railway", "cli", "bin", "railway.exe")
    : undefined;
  if (npmGlobal) {
    try {
      await access(npmGlobal);
      return npmGlobal;
    } catch {
      // Fall back to PATH.
    }
  }
  return "railway";
}

export function runCommand(command: string, args: string[], stdin?: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    // Deliberately NOT echoed to process.stdout, unlike the installer CLI's
    // runCommand: every command this CLI runs is a `railway variable`
    // subcommand, and Railway's own --json/--kv output includes raw
    // variable values (confirmed in its --help text). Streaming that
    // straight to the terminal would print secret values on the very first
    // real run — including a --dry-run's `variable list` call. Captured
    // here for parsing only.
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr!.on("data", (chunk: string) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    if (stdin !== undefined) {
      child.stdin!.end(stdin);
    }
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout });
      } else {
        // Whether a failed `variable set` can echo the attempted value on
        // stderr is not confirmed against a live instance (this session
        // deliberately made no live Railway calls) — noted as residual
        // risk in docs/plans/setup-profile-applier/review.md rather than
        // guessed at here.
        reject(new Error(`railway ${args.join(" ")} failed with exit code ${code}: ${stderr.trim()}`));
      }
    });
  });
}

if (isEntrypoint()) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

function isEntrypoint(): boolean {
  const invokedPath = process.argv[1];
  return Boolean(invokedPath && fileURLToPath(import.meta.url) === invokedPath);
}
