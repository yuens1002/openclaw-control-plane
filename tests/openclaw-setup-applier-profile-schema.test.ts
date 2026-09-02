import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseClientProfile } from "@openclaw-control-plane/openclaw-setup-applier/profile-schema";

describe("client profile schema", () => {
  it("parses a profile with a plain-secret model provider attachment", () => {
    const profile = parseClientProfile(readFixture("plain-secret-provider.json"));

    expect(profile.attachments.modelProviders[0]?.nonSecretConfig.authGroup).toBe("openrouter");
    expect(profile.attachments.modelProviders[0]?.requiredSecretNames).toEqual([
      "EXAMPLE_OPENROUTER_API_KEY"
    ]);
  });

  it("parses a profile with a keyProvisioning model provider attachment", () => {
    const profile = parseClientProfile(readFixture("key-provisioning-provider.json"));

    expect(profile.attachments.modelProviders[0]?.nonSecretConfig.keyProvisioning?.method).toBe(
      "openrouter-provisioning-api"
    );
    expect(profile.attachments.modelProviders[0]?.nonSecretConfig.keyProvisioning?.spendLimitUsd).toBe(25);
  });

  it("parses a profile with a channel attachment", () => {
    const profile = parseClientProfile(readFixture("channel.json"));

    expect(profile.attachments.channels[0]?.type).toBe("telegram");
  });

  it("parses a profile with an MCP server attachment", () => {
    const profile = parseClientProfile(readFixture("mcp-server.json"));

    expect(profile.attachments.mcpServers[0]?.name).toBe("example-mcp-server");
    expect(profile.attachments.mcpServers[0]?.transport).toBe("http");
    expect(profile.attachments.mcpServers[0]?.url).toBe("https://example-mcp-server.internal/mcp");
    expect(profile.attachments.mcpServers[0]?.requiredSecretNames).toEqual([
      "EXAMPLE_MCP_SERVER_BEARER_TOKEN"
    ]);
  });

  it("defaults mcpServers to an empty array when the profile omits it", () => {
    const profile = parseClientProfile(readFixture("channel.json"));

    expect(profile.attachments.mcpServers).toEqual([]);
  });

  it("passes through an unrecognized field on an MCP server attachment instead of failing", () => {
    const withExtraField = readFixture("mcp-server.json") as {
      attachments: { mcpServers: Array<Record<string, unknown>> };
    };
    withExtraField.attachments.mcpServers[0]!.description = "Example MCP server";

    expect(() => parseClientProfile(withExtraField)).not.toThrow();
  });

  it("passes through an unrecognized field instead of failing", () => {
    const withExtraField = readFixture("plain-secret-provider.json") as {
      attachments: { modelProviders: Array<Record<string, unknown>> };
    };
    withExtraField.attachments.modelProviders[0]!.displayName = "Example Provider";

    expect(() => parseClientProfile(withExtraField)).not.toThrow();
  });

  it("fails with the missing field's path when a consumed field is absent", () => {
    const missingFlow = readFixture("plain-secret-provider.json") as {
      attachments: { modelProviders: Array<{ nonSecretConfig: Record<string, unknown> }> };
    };
    delete missingFlow.attachments.modelProviders[0]!.nonSecretConfig.flow;

    expect(() => parseClientProfile(missingFlow)).toThrow(
      "attachments.modelProviders.0.nonSecretConfig.flow"
    );
  });
});

function readFixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../fixtures/setup-profile/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8"));
}
