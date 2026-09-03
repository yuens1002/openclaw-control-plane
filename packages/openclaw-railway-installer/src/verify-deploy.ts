// Pure logic for verify-deploy-cli.ts (issue #104): "did the Railway
// deployment triggered by this commit actually succeed?" Kept separate from
// the CLI wrapper so it's directly unit-testable, matching this repo's
// existing verify-proof.ts / verify-proof-cli.ts split.

import { terminalFailureStatuses, type DeploymentStatus } from "./index.js";

export interface RailwayDeployment {
  // Untyped at the boundary deliberately -- this is parsed JSON from
  // `railway deployment list --json`, not guaranteed to be exactly one of
  // DeploymentStatus's known values. classifyDeploymentStatus treats any
  // unrecognized value as "pending" rather than asserting the type here.
  status: string;
  meta?: {
    commitHash?: string | null;
  };
}

export type DeploymentOutcome = "success" | "failure" | "pending";

/**
 * Selects the deployment whose commit matches `commitSha`, never just the
 * first entry in the list -- a deploy triggered by a later commit (or a
 * manual redeploy) can push the one we actually care about out of the [0]
 * slot before this check ever runs. When multiple deployments share the same
 * commit (a manual redeploy of an unchanged commit), this returns the FIRST
 * match -- correct only because `railway deployment list` returns newest
 * first (confirmed against this same project's own deployment history);
 * this is not re-verified per call.
 */
export function selectDeploymentForCommit(
  deployments: RailwayDeployment[],
  commitSha: string
): RailwayDeployment | undefined {
  return deployments.find((d) => d.meta?.commitHash === commitSha);
}

/**
 * Classifies a Railway deployment status into success / failure / still
 * pending. "success" is exactly "SUCCESS"; failure is the same
 * `terminalFailureStatuses` set this package's own client-provisioning
 * poller (index.ts) already uses -- NOT just the obvious CRASHED/FAILED/
 * REMOVED/SKIPPED, but also NEEDS_APPROVAL/REMOVING/SLEEPING, none of which
 * will ever resolve to SUCCESS on their own. Reusing the same set matters
 * for more than DRY: getting this wrong here previously meant polling a
 * stuck NEEDS_APPROVAL deployment for the full timeout instead of reporting
 * it immediately. Everything else (including any status value this
 * package's DeploymentStatus type doesn't know about) is "pending".
 */
export function classifyDeploymentStatus(status: string): DeploymentOutcome {
  if (status === "SUCCESS") return "success";
  if (terminalFailureStatuses.has(status as DeploymentStatus)) return "failure";
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
