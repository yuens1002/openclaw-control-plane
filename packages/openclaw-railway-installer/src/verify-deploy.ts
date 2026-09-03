// Pure logic for verify-deploy-cli.ts (issue #104): "is the most recent
// Railway deployment for this service actually healthy?" A periodic
// snapshot check, not a per-push poll-to-completion -- see
// verify-deploy-cli.ts's header comment for why. Kept separate from the CLI
// wrapper so it's directly unit-testable, matching this repo's existing
// verify-proof.ts / verify-proof-cli.ts split.

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
 * Selects the deployment whose commit matches `commitSha` -- used only for
 * the manual `workflow_dispatch` / `RAILWAY_DEPLOY_TARGET_SHA` path, where a
 * specific commit is named explicitly. When multiple deployments share the
 * same commit (a manual redeploy of an unchanged commit), this returns the
 * FIRST match -- correct only because `railway deployment list` returns
 * newest first (confirmed against this same project's own deployment
 * history); this is not re-verified per call.
 */
export function selectDeploymentForCommit(
  deployments: RailwayDeployment[],
  commitSha: string
): RailwayDeployment | undefined {
  return deployments.find((d) => d.meta?.commitHash === commitSha);
}

/**
 * Selects the most recent deployment, period -- the default check mode.
 * This is deliberately NOT tied to "the deployment for the commit that
 * triggered this run": this check runs on a schedule (see
 * verify-deploy-cli.ts's header for why it can't be push-triggered), so by
 * the time any given run fires, `main`'s current HEAD may be several commits
 * ahead of whatever Railway is actually building, or the newest deployment
 * may still be mid-build. Checking "the latest deployment" rather than
 * matching a specific SHA also sidesteps the superseded-deployment false
 * positive a push-tied, per-commit check would hit: an OLDER deployment
 * legitimately going REMOVED/SKIPPED because a newer commit superseded it is
 * simply never looked at here.
 */
export function selectLatestDeployment(deployments: RailwayDeployment[]): RailwayDeployment | undefined {
  return deployments[0];
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
  // .trim() before the emptiness check -- a whitespace-only value ("   ")
  // is truthy in JS, so without this a plausible real misconfiguration
  // (an accidentally space-padded secret) would pass through as
  // "configured" with a garbage value, only failing later against the
  // actual Railway CLI call with a less obvious error.
  const projectId = env.RAILWAY_PROJECT_ID?.trim();
  const environmentId = env.RAILWAY_ENVIRONMENT_ID?.trim();
  const serviceId = env.RAILWAY_SERVICE_ID?.trim();
  if (!projectId || !environmentId || !serviceId) return undefined;
  return { projectId, environmentId, serviceId };
}
