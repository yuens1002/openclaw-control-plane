import { describe, expect, it } from "vitest";

import {
  StaticRbacAuthorizationProvider,
  TrustedContextCoordinator,
  exampleRuntimeAuthConfiguration,
  type AuthenticatedPrincipal
} from "@openclaw-control-plane/runtime-auth";

describe("static runtime RBAC", () => {
  it("allows exact actions and resource types with a complete ID wildcard", () => {
    const provider = createProvider();
    expect(provider.authorize(request())).toMatchObject({
      decision_id: "decision-1",
      result: "allowed",
      policy_version: "example-policy-v1",
      reason_codes: ["policy.allowed"]
    });
  });

  it.each([
    ["action", { action: "state.read" }],
    ["resource type", { resource: { type: "example.other", id: "production" } }]
  ])("denies an unmatched %s", (_case, override) => {
    const provider = createProvider();
    expect(provider.authorize({ ...request(), ...override })).toMatchObject({
      result: "denied",
      reason_codes: ["policy.no_matching_grant"]
    });
  });

  it("requires delegation independently of the principal role grant", () => {
    const provider = createProvider();
    expect(
      provider.authorize({
        ...request(),
        on_behalf_of_principal_id: "principal://example/operator"
      })
    ).toMatchObject({ result: "allowed" });
    expect(
      provider.authorize({
        ...request(),
        on_behalf_of_principal_id: "principal://example/missing"
      })
    ).toMatchObject({
      result: "denied",
      reason_codes: ["policy.invalid_delegation_target"]
    });
  });

  it("constructs trusted context from configured identity and delegation", () => {
    const provider = createProvider();
    const coordinator = new TrustedContextCoordinator(provider);
    const context = coordinator.authorize({
      ...request(),
      on_behalf_of_principal_id: "principal://example/operator"
    });

    expect(context).toEqual({
      authenticated_principal_ref: "principal://example/service",
      on_behalf_of_principal_ref: "principal://example/operator",
      effective_actor: { type: "user", id: "example-operator" },
      request_origin: "http",
      authorization: {
        decision_id: "decision-1",
        action: "state.reconcile",
        result: "allowed",
        policy_version: "example-policy-v1",
        reason_codes: ["policy.allowed"]
      }
    });
  });
});

function createProvider() {
  return new StaticRbacAuthorizationProvider(exampleRuntimeAuthConfiguration, {
    createDecisionId: () => "decision-1"
  });
}

function request() {
  return {
    authenticated_principal: authenticatedPrincipal(),
    action: "state.reconcile",
    resource: { type: "example.environment", id: "production" },
    request_origin: "http" as const
  };
}

function authenticatedPrincipal(): AuthenticatedPrincipal {
  return {
    issuer: "https://issuer.example",
    subject: "example-service",
    principal: exampleRuntimeAuthConfiguration.principals[0]!,
    claims: {
      iss: "https://issuer.example",
      sub: "example-service",
      name: "Mutable display name"
    }
  };
}
