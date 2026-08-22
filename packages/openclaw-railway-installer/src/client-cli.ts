import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  provisionClientInstance,
  updateClientOpenClawRef,
  updateClientTemplateRef,
  type ProvisionClientOptions,
  type UpdateClientOpenClawRefOptions,
  type UpdateClientTemplateRefOptions
} from "./provision-client.js";
import type { RailwayRunner } from "./index.js";

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const railway = await resolveRailwayExecutable();
  const runner: RailwayRunner = {
    run: (args, stdin) => runCommand(railway, args, stdin)
  };

  if (subcommand === "provision") {
    const options = parseProvisionArgs(rest);
    const result = await provisionClientInstance(options, { runner });
    console.log("");
    console.log("Client instance is ready.");
    console.log(`Setup URL: ${result.setupUrl}`);
    console.log(`OpenClaw URL: ${result.openclawUrl}`);
    console.log(`Username: ${result.setupUsername}`);
    console.log(`Setup password: ${result.setupPassword}`);
    console.log(`Service: ${result.serviceName} (${result.serviceId})`);
    console.log(`Template ref: ${result.templateRef}`);
    console.log(`Reused existing service: ${result.reusedExistingService}`);
    console.log(`Local env written: ${result.wroteEnvLocal}`);
    console.log(`Handoff written: ${result.wroteHandoff}`);
    return;
  }

  if (subcommand === "update-ref") {
    const options = parseUpdateRefArgs(rest);
    const result = await updateClientTemplateRef(options, { runner });
    console.log("");
    console.log(
      result.changed
        ? `Service '${result.serviceName}' redeployed on template ref ${result.templateRef}.`
        : `Service '${result.serviceName}' was already on template ref ${result.templateRef}; nothing redeployed.`
    );
    return;
  }

  if (subcommand === "update-openclaw-ref") {
    const options = parseUpdateOpenClawRefArgs(rest);
    const result = await updateClientOpenClawRef(options, { runner });
    console.log("");
    console.log(
      result.changed
        ? `Service '${result.serviceName}' redeployed on openclaw ref ${result.openclawRef}.`
        : `Service '${result.serviceName}' was already on openclaw ref ${result.openclawRef}; nothing redeployed.`
    );
    return;
  }

  throw new Error(
    `Unknown subcommand '${subcommand ?? ""}'. Expected 'provision', 'update-ref', or 'update-openclaw-ref'.`
  );
}

export function parseProvisionArgs(args: string[]): ProvisionClientOptions {
  const options: Partial<ProvisionClientOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--client-name":
        options.clientName = requireValue(arg, value);
        index += 1;
        break;
      case "--project-id":
        options.projectId = requireValue(arg, value);
        index += 1;
        break;
      case "--workspace":
        options.workspace = requireValue(arg, value);
        index += 1;
        break;
      case "--target-port":
        options.targetPort = parseIntegerFlag(arg, value);
        index += 1;
        break;
      case "--template-ref":
        options.templateRef = requireValue(arg, value);
        index += 1;
        break;
      case "--setup-username":
        options.setupUsername = requireValue(arg, value);
        index += 1;
        break;
      case "--poll-seconds":
        options.pollSeconds = parseIntegerFlag(arg, value);
        index += 1;
        break;
      case "--timeout-minutes":
        options.timeoutMinutes = parseIntegerFlag(arg, value);
        index += 1;
        break;
      case "--env-local-path":
        options.envLocalPath = requireValue(arg, value);
        index += 1;
        break;
      case "--handoff-path":
        options.handoffPath = requireValue(arg, value);
        index += 1;
        break;
      case "--force-new":
        options.forceNew = true;
        break;
      case "--no-local-files":
        options.writeLocalFiles = false;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.clientName) {
    throw new Error("Missing required --client-name");
  }

  return options as ProvisionClientOptions;
}

export function parseUpdateRefArgs(args: string[]): UpdateClientTemplateRefOptions {
  const options: Partial<UpdateClientTemplateRefOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--service":
        options.service = requireValue(arg, value);
        index += 1;
        break;
      case "--template-ref":
        options.templateRef = requireValue(arg, value);
        index += 1;
        break;
      case "--expected-current-ref":
        options.expectedCurrentRef = requireValue(arg, value);
        index += 1;
        break;
      case "--poll-seconds":
        options.pollSeconds = parseIntegerFlag(arg, value);
        index += 1;
        break;
      case "--timeout-minutes":
        options.timeoutMinutes = parseIntegerFlag(arg, value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.service) {
    throw new Error("Missing required --service");
  }
  if (!options.templateRef) {
    throw new Error("Missing required --template-ref");
  }
  if (!options.expectedCurrentRef) {
    throw new Error(
      "Missing required --expected-current-ref. State the ref you believe is currently set; " +
        "the update aborts if it does not match, so a concurrent change cannot be silently overwritten."
    );
  }

  return options as UpdateClientTemplateRefOptions;
}

export function parseUpdateOpenClawRefArgs(args: string[]): UpdateClientOpenClawRefOptions {
  const options: Partial<UpdateClientOpenClawRefOptions> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--service":
        options.service = requireValue(arg, value);
        index += 1;
        break;
      case "--expected-current-ref":
        options.expectedCurrentRef = requireValue(arg, value);
        index += 1;
        break;
      case "--openclaw-ref":
        options.openclawRef = requireValue(arg, value);
        index += 1;
        break;
      case "--poll-seconds":
        options.pollSeconds = parseIntegerFlag(arg, value);
        index += 1;
        break;
      case "--timeout-minutes":
        options.timeoutMinutes = parseIntegerFlag(arg, value);
        index += 1;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.service) {
    throw new Error("Missing required --service");
  }
  if (!options.openclawRef) {
    throw new Error("Missing required --openclaw-ref");
  }
  if (!options.expectedCurrentRef) {
    throw new Error(
      "Missing required --expected-current-ref. State the ref you believe is currently set; " +
        "the update aborts if it does not match, so a concurrent change cannot be silently overwritten."
    );
  }

  return options as UpdateClientOpenClawRefOptions;
}

function requireValue(flag: string, value: string | undefined): string {
  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseIntegerFlag(flag: string, value: string | undefined): number {
  const rawValue = requireValue(flag, value);
  if (!/^\d+$/.test(rawValue)) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  const parsed = Number.parseInt(rawValue, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer.`);
  }

  return parsed;
}

// Duplicated (not imported) from ./cli.ts: same rationale as guard-cli.ts —
// a handful of lines versus adding a new export to another entrypoint's
// module surface.
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
    // Deliberately NOT echoed to process.stdout, unlike the marketplace
    // installer CLI's runCommand: this CLI's command set includes `railway
    // variable list` (via readRailwayVariable, on the idempotent-rerun
    // path), and Railway's own --help text confirms --json/--kv output on
    // that subcommand includes raw variable values. Streaming that straight
    // to the terminal would print SETUP_PASSWORD/OPENCLAW_GATEWAY_TOKEN on
    // every rerun against an existing service. Captured here for parsing
    // only, same pattern as openclaw-setup-applier/src/cli.ts's runCommand.
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
