// LIVE-INSTANCE TIER: read
// See docs/live-instance-operations.md for what this tier permits.
//
// Not in the original tier-marking list, but every live call it makes is a
// read: Railway GraphQL queries for service source and runtime settings,
// `deployment list` and `domain list`, and unauthenticated GETs against
// the instance's own public routes recording status codes only. It writes
// nothing, and skips the live half entirely unless all four scoping
// environment variables are set. The verification logic it feeds is pure
// and takes a snapshot as input, so that module carries no tier.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  formatProofVerification,
  readProofSourceFiles,
  verifyOpenClawRailwayProof,
  type ProofDeployment,
  type ProofDomain,
  type ProofEndpointStatuses,
  type ProofServiceRuntimeSettings,
  type ProofServiceSource
} from "./verify-proof.js";

const execFileAsync = promisify(execFile);

async function main() {
  const sourceFiles = await readProofSourceFiles();
  const publicRepo =
    process.env.RAILWAY_EXPECTED_REPO ?? process.env.GITHUB_REPOSITORY ?? "yuens1002/openclaw-control-plane";
  const branch = process.env.RAILWAY_EXPECTED_BRANCH ?? "main";
  const targetPort = Number(process.env.RAILWAY_EXPECTED_PORT ?? 8080);

  const liveEnabled = Boolean(
    process.env.RAILWAY_PROJECT_ID &&
      process.env.RAILWAY_ENVIRONMENT_ID &&
      process.env.RAILWAY_SERVICE_ID &&
      process.env.RAILWAY_PROOF_URL
  );
  const liveRequired = process.env.RAILWAY_PROOF_LIVE_REQUIRED === "true";
  const expectedCommit = liveEnabled
    ? process.env.RAILWAY_EXPECTED_COMMIT || (await gitHead()).trim()
    : undefined;

  if (liveRequired && !liveEnabled) {
    throw new Error(
      "Live Railway proof checks are required. Set RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID, and RAILWAY_PROOF_URL."
    );
  }

  const result = verifyOpenClawRailwayProof(
    {
      sourceFiles,
      ...(liveEnabled
        ? {
            serviceSource: await serviceSource(),
            serviceRuntime: await serviceRuntime(),
            latestDeployment: await latestDeployment(),
            domains: await domains(),
            endpoints: await endpointStatuses(process.env.RAILWAY_PROOF_URL as string)
          }
        : {})
    },
    {
      publicRepo,
      branch,
      targetPort,
      ...(expectedCommit ? { expectedCommit } : {})
    }
  );

  console.log(formatProofVerification(result));
  if (!liveEnabled) {
    console.log(
      "SKIP live Railway checks: set RAILWAY_PROJECT_ID, RAILWAY_ENVIRONMENT_ID, RAILWAY_SERVICE_ID, and RAILWAY_PROOF_URL."
    );
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function serviceSource(): Promise<ProofServiceSource> {
  const query = `query serviceSource($serviceId: String!, $environmentId: String!) {
    service(id: $serviceId) {
      templateId
      templateServiceId
      templateThreadSlug
    }
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      upstreamUrl
      source { repo image }
    }
  }`;

  const payload = JSON.parse(
    await railwayApi(query, {
      serviceId: process.env.RAILWAY_SERVICE_ID as string,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID as string
    })
  ) as {
    data?: {
      service?: {
        templateId?: string | null;
        templateServiceId?: string | null;
        templateThreadSlug?: string | null;
      };
      serviceInstance?: {
        upstreamUrl?: string | null;
        source?: {
          repo?: string | null;
          image?: string | null;
        } | null;
      };
    };
  };

  return {
    ...(payload.data?.serviceInstance?.source?.repo !== undefined
      ? { repo: payload.data.serviceInstance.source.repo }
      : {}),
    ...(payload.data?.serviceInstance?.source?.image !== undefined
      ? { image: payload.data.serviceInstance.source.image }
      : {}),
    ...(payload.data?.serviceInstance?.upstreamUrl !== undefined
      ? { upstreamUrl: payload.data.serviceInstance.upstreamUrl }
      : {}),
    ...(payload.data?.service?.templateId !== undefined ? { templateId: payload.data.service.templateId } : {}),
    ...(payload.data?.service?.templateServiceId !== undefined
      ? { templateServiceId: payload.data.service.templateServiceId }
      : {}),
    ...(payload.data?.service?.templateThreadSlug !== undefined
      ? { templateThreadSlug: payload.data.service.templateThreadSlug }
      : {})
  };
}

async function serviceRuntime(): Promise<ProofServiceRuntimeSettings> {
  const query = `query serviceRuntime($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      builder
      dockerfilePath
      railwayConfigFile
      rootDirectory
      startCommand
      healthcheckPath
    }
  }`;

  const payload = JSON.parse(
    await railwayApi(query, {
      serviceId: process.env.RAILWAY_SERVICE_ID as string,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID as string
    })
  ) as {
    data?: {
      serviceInstance?: ProofServiceRuntimeSettings | null;
    };
  };

  return payload.data?.serviceInstance ?? {};
}

async function railwayApi(query: string, variables: Record<string, string>): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "openclaw-railway-api-"));
  const queryPath = join(workspace, "query.graphql");
  const variablesPath = join(workspace, "variables.json");

  try {
    await Promise.all([writeFile(queryPath, query), writeFile(variablesPath, JSON.stringify(variables))]);
    return await railway(["api", "--file", queryPath, "--variables", `@${variablesPath}`, "--compact"]);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

async function latestDeployment(): Promise<ProofDeployment> {
  const deployments = JSON.parse(await railway(["deployment", "list", ...railwayScope(), "--json"])) as Array<{
    status: string;
    meta?: {
      repo?: string | null;
      branch?: string | null;
      commitHash?: string | null;
    };
  }>;
  const latest = deployments[0];
  if (!latest) {
    throw new Error("No Railway deployments found.");
  }

  return {
    status: latest.status,
    ...(latest.meta?.repo !== undefined ? { repo: latest.meta.repo } : {}),
    ...(latest.meta?.branch !== undefined ? { branch: latest.meta.branch } : {}),
    ...(latest.meta?.commitHash !== undefined ? { commitHash: latest.meta.commitHash } : {})
  };
}

async function domains(): Promise<ProofDomain[]> {
  const result = JSON.parse(await railway(["domain", "list", ...railwayScope(), "--json"])) as {
    domains: ProofDomain[];
  };
  return result.domains;
}

async function endpointStatuses(baseUrl: string): Promise<ProofEndpointStatuses> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const [setupHealth, setup, openclaw] = await Promise.all([
    status(`${normalizedBaseUrl}/setup/healthz`),
    status(`${normalizedBaseUrl}/setup`),
    status(`${normalizedBaseUrl}/openclaw`)
  ]);

  return { setupHealth, setup, openclaw };
}

async function status(url: string): Promise<number> {
  const response = await fetch(url, { redirect: "manual" });
  return response.status;
}

async function railway(args: string[]): Promise<string> {
  const executable = process.env.RAILWAY_CLI_PATH ?? (process.platform === "win32" ? "railway.cmd" : "railway");
  const env = {
    ...process.env,
    RAILWAY_CALLER: "openclaw-control-plane:verify-proof",
    RAILWAY_AGENT_SESSION: process.env.RAILWAY_AGENT_SESSION ?? "openclaw-control-plane-verify-proof"
  };

  const command =
    process.platform === "win32" && executable.endsWith(".cmd")
      ? {
          file: process.env.ComSpec ?? "cmd.exe",
          args: ["/d", "/c", executable, ...args]
        }
      : {
          file: executable,
          args
        };

  const { stdout } = await execFileAsync(command.file, command.args, { env });
  return stdout;
}

function railwayScope(): string[] {
  return [
    "--project",
    process.env.RAILWAY_PROJECT_ID as string,
    "--environment",
    process.env.RAILWAY_ENVIRONMENT_ID as string,
    "--service",
    process.env.RAILWAY_SERVICE_ID as string
  ];
}

async function gitHead(): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"]);
  return stdout;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
