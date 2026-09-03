// Pure logic for verify-deploy-cli.ts (issue #104): "did the Railway
// deployment triggered by this commit actually succeed?" Kept separate from
// the CLI wrapper so it's directly unit-testable, matching this repo's
// existing verify-proof.ts / verify-proof-cli.ts split.

export interface RailwayDeployment {
  status: string;
  meta?: {
    commitHash?: string | null;
  };
}

export type DeploymentOutcome = "success" | "failure" | "pending";

// Terminal states per Railway's own deployment status enum. Anything else
// (BUILDING, DEPLOYING, INITIALIZING, QUEUED, WAITING, NEEDS_APPROVAL) is
// still in flight.
const TERMINAL_FAILURE_STATUSES = new Set(["FAILED", "CRASHED", "REMOVED", "SKIPPED"]);

/**
 * Selects the deployment whose commit matches `commitSha`, never just the
 * first entry in the list -- a deploy triggered by a later commit (or a
 * manual redeploy) can push the one we actually care about out of the [0]
 * slot before this check ever runs.
 */
export function selectDeploymentForCommit(
  deployments: RailwayDeployment[],
  commitSha: string
): RailwayDeployment | undefined {
  return deployments.find((d) => d.meta?.commitHash === commitSha);
}

/**
 * Classifies a Railway deployment status into success / failure / still
 * pending. "success" is exactly "SUCCESS" -- everything else terminal is a
 * failure, and everything non-terminal is pending.
 */
export function classifyDeploymentStatus(status: string): DeploymentOutcome {
  if (status === "SUCCESS") return "success";
  if (TERMINAL_FAILURE_STATUSES.has(status)) return "failure";
  return "pending";
}

export interface RailwayDeployConfig {
  projectId: string;
  environmentId: string;
  serviceId: string;
}

/**
 * Reads the three scoping env vars this check needs. Returns undefined
 * (not a throw) when any are missing -- the CLI treats that as "not
 * configured yet, skip" rather than a failure, matching verify-proof-cli.ts's
 * existing convention for its own four scoping vars.
 */
export function readRailwayDeployConfig(env: NodeJS.ProcessEnv): RailwayDeployConfig | undefined {
  const { RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID } = env;
  if (!RAILWAY_PROJECT_ID || !RAILWAY_ENVIRONMENT_ID || !RAILWAY_SERVICE_ID) return undefined;
  return { projectId: RAILWAY_PROJECT_ID, environmentId: RAILWAY_ENVIRONMENT_ID, serviceId: RAILWAY_SERVICE_ID };
}
