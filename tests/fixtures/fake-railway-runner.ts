import type { CommandResult, RailwayRunner } from "@openclaw-control-plane/openclaw-railway-installer";

export interface RecordedCommand {
  args: string[];
  stdin?: string;
}

// Shared fake for RailwayRunner: the union of the command shapes exercised
// by installOpenClawOnRailway (`deploy`), provisionClientInstance
// (`init`/`link`/`up`, `service <name>`, `volume`, `variable`), and
// updateClientTemplateRef (`variable set`, `redeploy`). Single source of
// truth for orchestration-level tests — the three test files that use this
// each previously carried their own partial copy of this dispatch logic.
export class FakeRailwayRunner implements RailwayRunner {
  readonly calls: RecordedCommand[] = [];
  private serviceListResponses: unknown[][];
  private domainListResponse: unknown = domainList(3000);
  private domainUpdateResponse: unknown = { domain: serviceDomain(8080) };
  private variableListResponse: Record<string, string> = {};
  /** When set, simulates a service with no domain yet until `domain --service` (generate) is called. */
  private domainGeneratesTo: unknown | undefined;

  constructor(serviceListResponses: unknown[][] = []) {
    this.serviceListResponses = [...serviceListResponses];
  }

  setDomainList(response: unknown): void {
    this.domainListResponse = response;
  }

  setDomainUpdate(response: unknown): void {
    this.domainUpdateResponse = response;
  }

  setVariableListResponse(response: Record<string, string>): void {
    this.variableListResponse = response;
  }

  /** Simulates a freshly-deployed service with no domain until the generate call lands. */
  setNoDomainUntilGenerated(generatedDomainListResponse: unknown): void {
    this.domainListResponse = { domains: [] };
    this.domainGeneratesTo = generatedDomainListResponse;
  }

  async run(args: string[], stdin?: string): Promise<CommandResult> {
    this.calls.push(stdin === undefined ? { args } : { args, stdin });
    const key = args.slice(0, 2).join(" ");

    if (args[0] === "deploy") {
      return { stdout: "Creating clawdbot-railway-template...\n" };
    }
    if (args[0] === "init" || args[0] === "link" || args[0] === "up") {
      return { stdout: "{}" };
    }
    if (key === "service list") {
      // Once only one (or zero) responses remain, keep returning it instead
      // of falling through to `[]` — a poll loop that outlives the queued
      // responses must keep seeing the last real status, not silently spin
      // forever against an empty service list.
      const next =
        this.serviceListResponses.length > 1
          ? this.serviceListResponses.shift()!
          : (this.serviceListResponses[0] ?? []);
      return { stdout: JSON.stringify(next) };
    }
    if (args[0] === "service") {
      // `railway service <name>` — links a service, no meaningful stdout.
      return { stdout: "" };
    }
    if (args[0] === "volume") {
      return { stdout: "" };
    }
    if (key === "variable set") {
      return { stdout: JSON.stringify([args[2]]) };
    }
    if (key === "variable list") {
      return { stdout: JSON.stringify(this.variableListResponse) };
    }
    if (args[0] === "redeploy") {
      return { stdout: "{}" };
    }
    if (key === "domain list") {
      return { stdout: JSON.stringify(this.domainListResponse) };
    }
    if (key === "domain update") {
      return { stdout: JSON.stringify(this.domainUpdateResponse) };
    }
    if (args[0] === "domain" && args[1] === "--service") {
      // The generate form (`railway domain --service <name> --port <n> --json`)
      // -- confirmed live to return `{domain: "<full-url>"}`, a different
      // shape than `domain list`/`update`. This fake doesn't need to
      // reproduce that shape exactly since the real code re-lists rather
      // than parsing it; it only needs to make the *next* `domain list`
      // call reflect that a domain now exists.
      if (this.domainGeneratesTo !== undefined) {
        this.domainListResponse = this.domainGeneratesTo;
      }
      return { stdout: JSON.stringify({ domain: "https://generated-example.up.railway.app" }) };
    }

    throw new Error(`Unexpected command: ${args.join(" ")}`);
  }
}

export function serviceDomain(targetPort: number) {
  return {
    domain: "acme-openclaw.example.com",
    type: "service",
    targetPort
  };
}

export function domainList(targetPort: number) {
  return {
    domains: [serviceDomain(targetPort)]
  };
}
