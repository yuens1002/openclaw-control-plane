import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";

import {
  bootstrapOnboardingCycle,
  runRegressionCheck,
  type BootstrapOnboardingCycleOptions,
  type RegressionCheckOptions
} from "./onboarding-cycle.js";
import { deleteOpenRouterKey } from "./openrouter-provisioning.js";

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const railway = await resolveRailwayExecutable();
  const runner: RailwayRunner = {
    run: (args, stdin) => runCommand(railway, args, stdin)
  };

  if (subcommand === "bootstrap") {
    const options = parseBootstrapArgs(rest);
    const profile = JSON.parse(await readFile(options.profilePath, "utf8")) as unknown;
    const openRouterManagementKey = requireEnv("OPENROUTER_MANAGEMENT_KEY");

    const cycleOptions: BootstrapOnboardingCycleOptions = {
      clientName: options.clientName,
      profile,
      ...(options.workspace !== undefined ? { workspace: options.workspace } : {}),
      ...(options.projectId !== undefined ? { projectId: options.projectId } : {})
    };
    const result = await bootstrapOnboardingCycle(cycleOptions, { runner, openRouterManagementKey });

    console.log("");
    console.log("Bootstrap complete.");
    console.log(`Setup URL: ${result.provision.setupUrl}`);
    console.log(`OpenClaw URL: ${result.provision.openclawUrl}`);
    console.log(`Username: ${result.provision.setupUsername}`);
    console.log(`Setup password: ${result.provision.setupPassword}`);
    console.log(`Reused existing service: ${result.provision.reusedExistingService}`);
    console.log(`Apply outcome: ${result.apply.outcome}`);
    if (result.apply.mintedKeyHash !== undefined) {
      console.log(`Minted OpenRouter key hash: ${result.apply.mintedKeyHash}`);
      console.log(
        "This key is LIVE and was not deleted. Once verification is done, run:"
      );
      console.log(`  onboarding-cycle delete-key --hash ${result.apply.mintedKeyHash}`);
    }
    return;
  }

  if (subcommand === "regression-check") {
    const options = parseRegressionCheckArgs(rest);
    const profile = JSON.parse(await readFile(options.profilePath, "utf8")) as unknown;
    const openRouterManagementKey = requireEnv("OPENROUTER_MANAGEMENT_KEY");
    const setupPassword = requireEnv("OPENCLAW_INSTANCE_SETUP_PASSWORD");
    const setupUsername = process.env.OPENCLAW_INSTANCE_SETUP_USERNAME ?? "openclaw";

    const checkOptions: RegressionCheckOptions = {
      service: options.service,
      instanceBaseUrl: options.instanceUrl,
      profile,
      setupUsername,
      setupPassword
    };
    const result = await runRegressionCheck(checkOptions, { runner, openRouterManagementKey });

    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.passed ? 0 : 1;
    return;
  }

  if (subcommand === "delete-key") {
    const options = parseDeleteKeyArgs(rest);
    const openRouterManagementKey = requireEnv("OPENROUTER_MANAGEMENT_KEY");
    await deleteOpenRouterKey(options.hash, { managementKey: openRouterManagementKey });
    console.log(`Deleted OpenRouter key ${options.hash}.`);
    return;
  }

  throw new Error(`Unknown subcommand '${subcommand ?? ""}'. Expected 'bootstrap', 'regression-check', or 'delete-key'.`);
}

interface BootstrapArgs {
  clientName: string;
  profilePath: string;
  workspace?: string;
  projectId?: string;
}

export function parseBootstrapArgs(args: string[]): BootstrapArgs {
  const options: Partial<BootstrapArgs> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--client-name":
        options.clientName = requireValue(arg, value);
        index += 1;
        break;
      case "--profile":
        options.profilePath = requireValue(arg, value);
        index += 1;
        break;
      case "--workspace":
        options.workspace = requireValue(arg, value);
        index += 1;
        break;
      case "--project-id":
        options.projectId = requireValue(arg, value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.clientName) {
    throw new Error("Missing required --client-name");
  }
  if (!options.profilePath) {
    throw new Error("Missing required --profile");
  }
  return options as BootstrapArgs;
}

interface RegressionCheckArgs {
  service: string;
  instanceUrl: string;
  profilePath: string;
}

export function parseRegressionCheckArgs(args: string[]): RegressionCheckArgs {
  const options: Partial<RegressionCheckArgs> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--service":
        options.service = requireValue(arg, value);
        index += 1;
        break;
      case "--instance-url":
        options.instanceUrl = requireValue(arg, value);
        index += 1;
        break;
      case "--profile":
        options.profilePath = requireValue(arg, value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.service) {
    throw new Error("Missing required --service");
  }
  if (!options.instanceUrl) {
    throw new Error("Missing required --instance-url");
  }
  if (!options.profilePath) {
    throw new Error("Missing required --profile");
  }
  return options as RegressionCheckArgs;
}

interface DeleteKeyArgs {
  hash: string;
}

export function parseDeleteKeyArgs(args: string[]): DeleteKeyArgs {
  const options: Partial<DeleteKeyArgs> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--hash") {
      options.hash = requireValue(arg, value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!options.hash) {
    throw new Error("Missing required --hash");
  }
  return options as DeleteKeyArgs;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

// Duplicated (not imported) from packages/openclaw-railway-installer/src/client-cli.ts:
// that module doesn't export these, and the duplication is a handful of
// lines versus adding new exports to another package's CLI entrypoint —
// same rationale as every other CLI entrypoint in this repo.
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
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    // Deliberately NOT echoed to process.stdout — this CLI's command set
    // includes `railway variable list` (via writeRailwayVariable/apply's
    // reader path), and Railway's own --json/--kv output includes raw
    // variable values. Captured here for parsing only, same pattern as
    // every other CLI entrypoint in this repo.
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
        resolvePromise({ stdout });
      } else {
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
