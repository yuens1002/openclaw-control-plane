import { describe, expect, it } from "vitest";

import {
  RuntimeAuthConfigurationSchema,
  exampleRuntimeAuthConfiguration,
  parseRuntimeAuthConfiguration
} from "@openclaw-control-plane/runtime-auth";

describe("runtime auth configuration", () => {
  it("parses the versioned public fixture", () => {
    expect(RuntimeAuthConfigurationSchema.parse(exampleRuntimeAuthConfiguration)).toEqual(
      exampleRuntimeAuthConfiguration
    );
  });

  it.each([
    [
      "duplicate identities",
      {
        principals: [
          ...exampleRuntimeAuthConfiguration.principals,
          { ...exampleRuntimeAuthConfiguration.principals[0]! }
        ]
      }
    ],
    [
      "unknown roles",
      {
        principals: [
          { ...exampleRuntimeAuthConfiguration.principals[0]!, roles: ["role.unknown"] },
          exampleRuntimeAuthConfiguration.principals[1]!
        ]
      }
    ],
    [
      "duplicate principal IDs",
      {
        principals: [
          exampleRuntimeAuthConfiguration.principals[0]!,
          {
            ...exampleRuntimeAuthConfiguration.principals[1]!,
            principal_id: exampleRuntimeAuthConfiguration.principals[0]!.principal_id
          }
        ]
      }
    ],
    [
      "duplicate audiences",
      {
        issuers: [
          { ...exampleRuntimeAuthConfiguration.issuers[0]!, audiences: ["control-plane", "control-plane"] }
        ]
      }
    ],
    [
      "unsupported algorithms",
      {
        issuers: [
          { ...exampleRuntimeAuthConfiguration.issuers[0]!, allowed_algorithms: ["HS256"] }
        ]
      }
    ],
    [
      "out-of-range clock skew",
      {
        issuers: [
          { ...exampleRuntimeAuthConfiguration.issuers[0]!, clock_skew_seconds: 301 }
        ]
      }
    ],
    [
      "unsafe role names",
      {
        roles: [{ ...exampleRuntimeAuthConfiguration.roles[0]!, name: "Unsafe Role" }]
      }
    ],
    [
      "partial resource globs",
      {
        roles: [
          {
            ...exampleRuntimeAuthConfiguration.roles[0]!,
            grants: [
              {
                authorization_action: "state.reconcile",
                resources: [{ type: "example.environment", id: "prod*" }]
              }
            ]
          }
        ]
      }
    ],
    [
      "invalid delegation targets",
      {
        delegations: [
          {
            ...exampleRuntimeAuthConfiguration.delegations[0]!,
            on_behalf_of_principal_id: "principal://example/missing"
          }
        ]
      }
    ],
    ["unsupported providers", { authorization_policy: { provider: "other", policy_version: "v1" } }]
  ])("rejects %s", (_case, override) => {
    expect(
      RuntimeAuthConfigurationSchema.safeParse({
        ...exampleRuntimeAuthConfiguration,
        ...override
      }).success
    ).toBe(false);
  });

  it("disables development Basic Authentication in production", () => {
    expect(() =>
      parseRuntimeAuthConfiguration(
        {
          ...exampleRuntimeAuthConfiguration,
          development_basic_auth: { enabled: true }
        },
        "production"
      )
    ).toThrow(/cannot be enabled in production/i);

    expect(
      parseRuntimeAuthConfiguration(
        {
          ...exampleRuntimeAuthConfiguration,
          development_basic_auth: { enabled: true }
        },
        "development"
      ).development_basic_auth?.enabled
    ).toBe(true);
  });

  it("requires issuer and principal mappings in production", () => {
    expect(() =>
      parseRuntimeAuthConfiguration(
        {
          ...exampleRuntimeAuthConfiguration,
          issuers: [],
          principals: [],
          delegations: []
        },
        "production"
      )
    ).toThrow(/requires an issuer and principal mapping/i);
  });

  it("requires HTTPS issuer and JWKS URLs in production", () => {
    expect(() =>
      parseRuntimeAuthConfiguration(
        {
          ...exampleRuntimeAuthConfiguration,
          issuers: [
            {
              ...exampleRuntimeAuthConfiguration.issuers[0]!,
              jwks_uri: "http://issuer.example/.well-known/jwks.json"
            }
          ]
        },
        "production"
      )
    ).toThrow(/must use HTTPS/i);
  });
});
