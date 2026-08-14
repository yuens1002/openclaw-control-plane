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
