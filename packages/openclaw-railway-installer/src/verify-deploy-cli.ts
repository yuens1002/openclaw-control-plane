// LIVE-INSTANCE TIER: read
// See docs/live-instance-operations.md for what this tier permits. The only
// live call this makes is a read: `railway deployment list`. It writes
// nothing, and skips entirely unless RAILWAY_PROJECT_ID/RAILWAY_ENVIRONMENT_ID/
// RAILWAY_SERVICE_ID are all set (verify-proof-cli.ts's same convention for
// its own scoping vars).
//
// Confirms the Railway deployment triggered by a given commit (default:
// current HEAD) actually reached SUCCESS. Closes the detection gap from
// issue #104: GitHub Actions CI (unit tests, typecheck) knows nothing about
// whether the real Railway build/deploy succeeded, so a deploy could (and
// did, for 26+ hours) keep failing with CI staying green the whole time.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  classifyDeploymentStatus,
  readRailwayDeployConfig,
  selectDeploymentForCommit,
  type RailwayDeployment
} from "./verify-deploy.js";

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 15_000;
const MAX_POLL_ATTEMPTS = 40; // ~10 minutes

async function main() {
  const config = readRailwayDeployConfig(process.env);
  if (!config) {
    console.log(
      "SKIP: RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID are not all set -- " +
        "not configured yet, skipping the Railway deploy-status check."
    );
    return;
  }

  const targetSha = process.env.RAILWAY_DEPLOY_TARGET_SHA || (await gitHead());

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    const deployments = await listDeployments(config);
    const match = selectDeploymentForCommit(deployments, targetSha);

    if (!match) {
      console.log(`[${attempt}/${MAX_POLL_ATTEMPTS}] no deployment found yet for commit ${targetSha}, waiting...`);
    } else {
      const outcome = classifyDeploymentStatus(match.status);
      if (outcome === "success") {
        console.log(`Railway deployment for commit ${targetSha} reached SUCCESS.`);
        return;
      }
      if (outcome === "failure") {
        console.error(`BLOCKED: Railway deployment for commit ${targetSha} ended in status ${match.status}.`);
        process.exitCode = 1;
        return;
      }
      console.log(`[${attempt}/${MAX_POLL_ATTEMPTS}] deployment for commit ${targetSha} is still ${match.status}, waiting...`);
    }

    if (attempt < MAX_POLL_ATTEMPTS) {
      await sleep(POLL_INTERVAL_MS);
    }
  }

  console.error(
    `BLOCKED: no Railway deployment for commit ${targetSha} reached a terminal state within ` +
      `${(MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS) / 60_000} minutes.`
  );
  process.exitCode = 1;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listDeployments(config: {
  projectId: string;
  environmentId: string;
  serviceId: string;
}): Promise<RailwayDeployment[]> {
  const stdout = await railway([
    "deployment",
    "list",
    "--project",
    config.projectId,
    "--environment",
    config.environmentId,
    "--service",
    config.serviceId,
    "--json"
  ]);
  return JSON.parse(stdout) as RailwayDeployment[];
}

async function railway(args: string[]): Promise<string> {
  const executable = process.env.RAILWAY_CLI_PATH ?? (process.platform === "win32" ? "railway.cmd" : "railway");
  const env = {
    ...process.env,
    RAILWAY_CALLER: "openclaw-control-plane:verify-deploy",
    RAILWAY_AGENT_SESSION: process.env.RAILWAY_AGENT_SESSION ?? "openclaw-control-plane-verify-deploy"
  };

  const command =
    process.platform === "win32" && executable.endsWith(".cmd")
      ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/c", executable, ...args] }
      : { file: executable, args };

  const { stdout } = await execFileAsync(command.file, command.args, { env });
  return stdout;
}

async function gitHead(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout.trim();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
