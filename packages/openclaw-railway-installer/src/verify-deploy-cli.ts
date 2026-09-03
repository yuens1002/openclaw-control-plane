// LIVE-INSTANCE TIER: read
// See docs/live-instance-operations.md for what this tier permits. The only
// live call this makes is a read: `railway deployment list`. It writes
// nothing, and skips entirely unless RAILWAY_PROJECT_ID/RAILWAY_ENVIRONMENT_ID/
// RAILWAY_SERVICE_ID are all set (verify-proof-cli.ts's same convention for
// its own scoping vars).
//
// Confirms the most recent Railway deployment for this service is actually
// healthy. Closes the detection gap from issue #104: GitHub Actions CI (unit
// tests, typecheck) knows nothing about whether the real Railway build/
// deploy succeeded, so a deploy could (and did, for 26+ hours) keep failing
// with CI staying green the whole time.
//
// DELIBERATELY schedule-triggered, not push-triggered (see the workflow
// file) -- this repo's Railway service has "Wait for CI" enabled
// (source.checkSuites: true), which holds new deployments in WAITING until
// every push-triggered GitHub check suite on that commit finishes, and marks
// the deployment SKIPPED if any of them fails. A push-triggered version of
// this exact check would BE one of those check suites: it would poll for the
// deployment to leave WAITING, which Railway will never do until this
// workflow itself finishes -- a deadlock that stops every future commit from
// deploying at all. A schedule-triggered workflow is outside what Wait for
// CI waits for (Railway's own docs scope that feature to push-triggered
// workflows), so this only ever OBSERVES deployment state after the fact,
// never gates it.
//
// This also means: no poll-to-completion loop. A scheduled run takes exactly
// one snapshot of the most recent deployment (see selectLatestDeployment)
// and classifies it -- SUCCESS is fine, still-building/pending is fine (the
// next scheduled run will see it if it finishes), and a genuine terminal
// failure is reported immediately. There is no fixed "wait N minutes" budget
// to get wrong against a build whose real duration varies (a cached deploy
// finishes in ~1 minute; a cold build after an OPENCLAW_GIT_REF bump can
// take 10+ minutes).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  classifyDeploymentStatus,
  readRailwayDeployConfig,
  selectDeploymentForCommit,
  selectLatestDeployment,
  type RailwayDeployment
} from "./verify-deploy.js";

const execFileAsync = promisify(execFile);

async function main() {
  const config = readRailwayDeployConfig(process.env);
  if (!config) {
    console.log(
      "SKIP: RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, and RAILWAY_SERVICE_ID are not all set -- " +
        "not configured yet, skipping the Railway deploy-status check."
    );
    return;
  }

  let deployments: RailwayDeployment[];
  try {
    deployments = await listDeployments(config);
  } catch (error) {
    // A transient failure to even ask Railway about deployments (network
    // blip, a momentary API error) is not itself evidence of a bad deploy --
    // fail the job so it's visible, but don't misreport it as a deployment
    // failure. The next scheduled run tries again.
    console.error(`BLOCKED: could not query Railway for deployment status (${describeError(error)}).`);
    process.exitCode = 1;
    return;
  }

  const targetSha = process.env.RAILWAY_DEPLOY_TARGET_SHA;
  const deployment = targetSha ? selectDeploymentForCommit(deployments, targetSha) : selectLatestDeployment(deployments);

  if (!deployment) {
    const scope = targetSha ? `for commit ${targetSha}` : "at all";
    console.log(`No Railway deployment found ${scope} -- nothing to verify yet.`);
    return;
  }

  const outcome = classifyDeploymentStatus(deployment.status);
  const commitDescription = deployment.meta?.commitHash ? ` (commit ${deployment.meta.commitHash})` : "";

  if (outcome === "success") {
    console.log(`Railway deployment${commitDescription} is SUCCESS.`);
    return;
  }
  if (outcome === "failure") {
    console.error(`BLOCKED: Railway deployment${commitDescription} is in status ${deployment.status}.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Railway deployment${commitDescription} is still ${deployment.status} -- not a failure, checking again next run.`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

main().catch((error: unknown) => {
  console.error(describeError(error));
  process.exitCode = 1;
});
