import { readFile } from "node:fs/promises";

export interface ProofSourceFiles {
  dockerfile: string;
  railwayToml: string;
  templateLock: {
    upstreamRepo: string;
    upstreamRef: string;
    pinnedCommit: string;
  };
}

export interface ProofDeployment {
  status: string;
  repo?: string | null;
  branch?: string | null;
  commitHash?: string | null;
}

export interface ProofServiceSource {
  repo?: string | null;
  image?: string | null;
  upstreamUrl?: string | null;
  templateId?: string | null;
  templateServiceId?: string | null;
  templateThreadSlug?: string | null;
}

export interface ProofServiceRuntimeSettings {
  builder?: string | null;
  dockerfilePath?: string | null;
  railwayConfigFile?: string | null;
  rootDirectory?: string | null;
  startCommand?: string | null;
  healthcheckPath?: string | null;
}

export interface ProofDomain {
  domain: string;
  type: string;
  targetPort?: number;
  syncStatus?: string;
}

export interface ProofEndpointStatuses {
  setupHealth: number;
  setup: number;
  openclaw: number;
}

export interface ProofSnapshot {
  sourceFiles: ProofSourceFiles;
  serviceSource?: ProofServiceSource;
  serviceRuntime?: ProofServiceRuntimeSettings;
  latestDeployment?: ProofDeployment;
  domains?: ProofDomain[];
  endpoints?: ProofEndpointStatuses;
}

export interface ProofExpectations {
  publicRepo: string;
  branch: string;
  expectedCommit?: string;
  targetPort: number;
}

export interface ProofCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProofVerificationResult {
  ok: boolean;
  checks: ProofCheck[];
}

export function verifyOpenClawRailwayProof(
  snapshot: ProofSnapshot,
  expectations: ProofExpectations
): ProofVerificationResult {
  const checks: ProofCheck[] = [
    check(
      "railway.toml uses Dockerfile runtime",
      snapshot.sourceFiles.railwayToml.includes('builder = "dockerfile"'),
      "Railway source should build the OpenClaw runtime Dockerfile, not infer the API shell."
    ),
    check(
      "railway.toml healthcheck targets OpenClaw setup wrapper",
      snapshot.sourceFiles.railwayToml.includes('healthcheckPath = "/setup/healthz"'),
      "Healthcheck must prove the OpenClaw wrapper is serving /setup/healthz."
    ),
    check(
      "railway.toml requires persistent /data",
      snapshot.sourceFiles.railwayToml.includes('requiredMountPath = "/data"'),
      "OpenClaw runtime state should be mounted at /data."
    ),
    check(
      "Dockerfile pins upstream template commit",
      snapshot.sourceFiles.dockerfile.includes(
        `ARG OPENCLAW_TEMPLATE_REF=${snapshot.sourceFiles.templateLock.pinnedCommit}`
      ),
      "Dockerfile should pull the same pinned wrapper commit as template-lock.json."
    ),
    check(
      "Dockerfile uses upstream runtime dependency",
      snapshot.sourceFiles.dockerfile.includes(snapshot.sourceFiles.templateLock.upstreamRepo) &&
        snapshot.sourceFiles.dockerfile.includes("COPY --from=template-source /template/src ./src"),
      "Public repo should govern the wrapper dependency instead of replacing it with the API shell."
    )
  ];

  if (snapshot.serviceSource) {
    const historicalTemplateMetadata = [
      snapshot.serviceSource.templateId ? "templateId" : null,
      snapshot.serviceSource.templateServiceId ? "templateServiceId" : null,
      snapshot.serviceSource.templateThreadSlug ? "templateThreadSlug" : null
    ].filter(Boolean);

    checks.push(
      check(
        "Railway service source is public repo",
        snapshot.serviceSource.repo === expectations.publicRepo,
        `Railway service source repo is ${snapshot.serviceSource.repo ?? "unknown"}.`
      ),
      check(
        "Railway service is not sourced from an image",
        !snapshot.serviceSource.image,
        `Railway service source image is ${snapshot.serviceSource.image ?? "not set"}.`
      ),
      check(
        "Railway service upstream is not the template repo",
        !snapshot.serviceSource.upstreamUrl?.includes(snapshot.sourceFiles.templateLock.upstreamRepo),
        `Railway service upstream URL is ${snapshot.serviceSource.upstreamUrl ?? "not set"}.`
      ),
      check(
        "Railway service template metadata is historical only",
        true,
        historicalTemplateMetadata.length > 0
          ? `Railway retains historical ${historicalTemplateMetadata.join(", ")}; active source and upstream checks determine ownership.`
          : "No historical template metadata found."
      )
    );
  }

  if (snapshot.serviceRuntime) {
    checks.push(
      check(
        "Railway runtime builder uses Dockerfile",
        normalize(snapshot.serviceRuntime.builder) === "dockerfile",
        `Railway runtime builder is ${snapshot.serviceRuntime.builder ?? "unknown"}.`
      ),
      check(
        "Railway runtime uses repo root",
        ["", "."].includes(normalizePath(snapshot.serviceRuntime.rootDirectory)),
        `Railway runtime root directory is ${snapshot.serviceRuntime.rootDirectory ?? "repo root"}.`
      ),
      check(
        "Railway runtime config file is railway.toml",
        normalizePath(snapshot.serviceRuntime.railwayConfigFile) === "railway.toml",
        `Railway runtime config file is ${snapshot.serviceRuntime.railwayConfigFile ?? "not set"}.`
      ),
      check(
        "Railway runtime Dockerfile path is repo Dockerfile",
        ["", "dockerfile"].includes(normalizePath(snapshot.serviceRuntime.dockerfilePath)),
        `Railway runtime Dockerfile path is ${snapshot.serviceRuntime.dockerfilePath ?? "inherited from railway.toml"}.`
      ),
      check(
        "Railway runtime healthcheck targets setup wrapper",
        snapshot.serviceRuntime.healthcheckPath === "/setup/healthz",
        `Railway runtime healthcheck path is ${snapshot.serviceRuntime.healthcheckPath ?? "unknown"}.`
      ),
      check(
        "Railway runtime start command does not override OpenClaw wrapper",
        isAllowedStartCommand(snapshot.serviceRuntime.startCommand),
        `Railway runtime start command is ${snapshot.serviceRuntime.startCommand ?? "Dockerfile CMD"}.`
      )
    );
  }

  if (snapshot.latestDeployment) {
    checks.push(
      check(
        "latest deployment succeeded",
        snapshot.latestDeployment.status === "SUCCESS",
        `Latest Railway deployment status is ${snapshot.latestDeployment.status}.`
      ),
      check(
        "latest deployment source is public repo",
        snapshot.latestDeployment.repo === expectations.publicRepo,
        `Latest Railway deployment repo is ${snapshot.latestDeployment.repo ?? "unknown"}.`
      ),
      check(
        "latest deployment does not source upstream template directly",
        snapshot.latestDeployment.repo !== snapshot.sourceFiles.templateLock.upstreamRepo,
        "Railway source should be the public control-plane repo; upstream remains a pinned dependency."
      ),
      check(
        "latest deployment branch matches expected branch",
        snapshot.latestDeployment.branch === expectations.branch,
        `Latest Railway deployment branch is ${snapshot.latestDeployment.branch ?? "unknown"}.`
      )
    );

    if (expectations.expectedCommit) {
      checks.push(
        check(
          "latest deployment matches expected commit",
          snapshot.latestDeployment.commitHash === expectations.expectedCommit,
          `Latest Railway deployment commit is ${snapshot.latestDeployment.commitHash ?? "unknown"}.`
        )
      );
    }
  }

  if (snapshot.domains) {
    const activeServiceDomain = snapshot.domains.find(
      (domain) => domain.type === "service" && domain.syncStatus === "ACTIVE"
    );
    checks.push(
      check(
        "active Railway service domain exists",
        Boolean(activeServiceDomain),
        activeServiceDomain
          ? `Active domain is ${activeServiceDomain.domain}.`
          : "No active service domain found."
      ),
      check(
        "active Railway service domain targets OpenClaw wrapper port",
        activeServiceDomain?.targetPort === expectations.targetPort,
        `Active domain target port is ${activeServiceDomain?.targetPort ?? "unknown"}.`
      )
    );
  }

  if (snapshot.endpoints) {
    checks.push(
      check(
        "live setup healthcheck passes",
        snapshot.endpoints.setupHealth === 200,
        `/setup/healthz returned ${snapshot.endpoints.setupHealth}.`
      ),
      check(
        "live setup route exists",
        [200, 301, 302, 401].includes(snapshot.endpoints.setup),
        `/setup returned ${snapshot.endpoints.setup}; expected setup HTML, redirect, or Basic auth challenge.`
      ),
      check(
        "live OpenClaw route exists",
        [200, 301, 302, 401].includes(snapshot.endpoints.openclaw),
        `/openclaw returned ${snapshot.endpoints.openclaw}; expected UI HTML, redirect, or Basic auth challenge.`
      )
    );
  }

  return {
    ok: checks.every((candidate) => candidate.ok),
    checks
  };
}

export async function readProofSourceFiles(
  dockerfilePath = "Dockerfile",
  railwayTomlPath = "railway.toml",
  templateLockPath = "deploy/openclaw-railway/template-lock.json"
): Promise<ProofSourceFiles> {
  const [dockerfile, railwayToml, rawLock] = await Promise.all([
    readFile(dockerfilePath, "utf8"),
    readFile(railwayTomlPath, "utf8"),
    readFile(templateLockPath, "utf8")
  ]);

  const templateLock = JSON.parse(rawLock) as ProofSourceFiles["templateLock"];
  return {
    dockerfile,
    railwayToml,
    templateLock
  };
}

export function formatProofVerification(result: ProofVerificationResult): string {
  return result.checks
    .map((candidate) => `${candidate.ok ? "PASS" : "FAIL"} ${candidate.name}: ${candidate.detail}`)
    .join("\n");
}

function check(name: string, ok: boolean, detail: string): ProofCheck {
  return { name, ok, detail };
}

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function normalizePath(value: string | null | undefined): string {
  return normalize(value).replace(/^\/+/, "").replace(/\\/g, "/");
}

function isAllowedStartCommand(value: string | null | undefined): boolean {
  const normalized = normalize(value);
  return normalized === "" || normalized === "node src/server.js";
}
