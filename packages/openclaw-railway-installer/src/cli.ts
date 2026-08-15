import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { installOpenClawOnRailway, type InstallerOptions, type RailwayRunner } from "./index.js";

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const railway = await resolveRailwayExecutable();
  const runner: RailwayRunner = {
    run: (args, stdin) => runCommand(railway, args, stdin)
  };

  const result = await installOpenClawOnRailway(options, { runner });
  console.log("");
  console.log("OpenClaw is ready.");
  console.log(`Setup URL: ${result.setupUrl}`);
  console.log(`OpenClaw URL: ${result.openclawUrl}`);
  console.log(`Username: ${result.setupUsername}`);
  console.log(`Setup password: ${result.setupPassword}`);
  console.log(`Service: ${result.serviceName} (${result.serviceId})`);
  console.log(`Local env written: ${result.wroteEnvLocal}`);
  console.log(`Handoff written: ${result.wroteHandoff}`);
}

export function parseArgs(args: string[]): InstallerOptions {
  const options: InstallerOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    switch (arg) {
      case "--template":
        options.template = requireValue(arg, value);
        index += 1;
        break;
      case "--service":
        options.service = requireValue(arg, value);
        index += 1;
        break;
      case "--target-port":
        options.targetPort = parseIntegerFlag(arg, value);
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
      case "--setup-username":
        options.setupUsername = requireValue(arg, value);
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
  return options;
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

function runCommand(command: string, args: string[], stdin?: string): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      shell: false
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (chunk: string) => {
      stdout += chunk;
      process.stdout.write(chunk);
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
