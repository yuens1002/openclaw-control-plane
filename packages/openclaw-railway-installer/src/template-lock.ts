import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export interface TemplateLock {
  template: string;
  upstreamRepo: string;
  upstreamBranch: string;
  upstreamRef: string;
  pinnedCommit: string;
  mirror: {
    requiredForImmutableProofInstance: boolean;
    approvedBranch: string;
    status: string;
  };
  policy: {
    updateCadence: string;
    autoApply: boolean;
    requiresSmokeBeforeBump: boolean;
  };
  notes?: string[];
}

export interface TemplateUpdateStatus {
  status: "current" | "update_available";
  lock: TemplateLock;
  latestCommit: string;
}

export type FetchCommit = (lock: TemplateLock) => Promise<string>;

const shaPattern = /^[a-f0-9]{40}$/;

export async function readTemplateLock(path: string): Promise<TemplateLock> {
  const rawLock = JSON.parse(await readFile(resolve(path), "utf8")) as unknown;
  return parseTemplateLock(rawLock);
}

export function parseTemplateLock(candidate: unknown): TemplateLock {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("Template lock must be a JSON object.");
  }

  const lock = candidate as Partial<TemplateLock>;
  const requiredStrings = [
    ["template", lock.template],
    ["upstreamRepo", lock.upstreamRepo],
    ["upstreamBranch", lock.upstreamBranch],
    ["upstreamRef", lock.upstreamRef],
    ["pinnedCommit", lock.pinnedCommit]
  ] as const;

  for (const [key, value] of requiredStrings) {
    if (!value || typeof value !== "string") {
      throw new Error(`Template lock is missing '${key}'.`);
    }
  }

  const pinnedCommit = lock.pinnedCommit;
  if (!pinnedCommit || !shaPattern.test(pinnedCommit)) {
    throw new Error("Template lock pinnedCommit must be a 40-character lowercase Git SHA.");
  }

  const mirror = lock.mirror;
  if (!mirror?.approvedBranch || typeof mirror.approvedBranch !== "string") {
    throw new Error("Template lock is missing mirror.approvedBranch.");
  }

  if (!mirror.status || typeof mirror.status !== "string") {
    throw new Error("Template lock is missing mirror.status.");
  }

  if (mirror.requiredForImmutableProofInstance !== true) {
    throw new Error("Template lock must require a mirror for immutable proof instances.");
  }

  const policy = lock.policy;
  if (!policy?.updateCadence || typeof policy.updateCadence !== "string") {
    throw new Error("Template lock is missing policy.updateCadence.");
  }

  if (policy?.autoApply !== false) {
    throw new Error("Template lock policy.autoApply must be false.");
  }

  if (policy.requiresSmokeBeforeBump !== true) {
    throw new Error("Template lock policy.requiresSmokeBeforeBump must be true.");
  }

  return lock as TemplateLock;
}

export async function checkTemplateUpdate(
  lock: TemplateLock,
  fetchCommit: FetchCommit = fetchLatestCommit
): Promise<TemplateUpdateStatus> {
  const latestCommit = await fetchCommit(lock);
  if (!shaPattern.test(latestCommit)) {
    throw new Error("Upstream commit lookup returned an invalid Git SHA.");
  }

  return {
    status: latestCommit === lock.pinnedCommit ? "current" : "update_available",
    lock,
    latestCommit
  };
}

export async function fetchLatestCommit(lock: TemplateLock): Promise<string> {
  const ref = encodeURIComponent(lock.upstreamRef);
  const response = await fetch(
    `https://api.github.com/repos/${lock.upstreamRepo}/commits/${ref}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN
          ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {})
      }
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub commit lookup failed for ${lock.upstreamRepo}@${lock.upstreamRef}: ${response.status}`
    );
  }

  const payload = (await response.json()) as { sha?: unknown };
  if (typeof payload.sha !== "string") {
    throw new Error("GitHub commit lookup did not return a sha.");
  }

  return payload.sha;
}

export function formatTemplateUpdateStatus(result: TemplateUpdateStatus): string {
  const lines = [
    `Template: ${result.lock.template}`,
    `Upstream: ${result.lock.upstreamRepo}@${result.lock.upstreamBranch}`,
    `Pinned: ${result.lock.pinnedCommit}`,
    `Latest: ${result.latestCommit}`,
    `Status: ${result.status}`
  ];

  if (result.status === "update_available") {
    lines.push(
      "Action: run a Railway proof smoke before bumping template-lock.json or advancing the approved mirror branch."
    );
  }

  return lines.join("\n");
}
