import type { RuntimeAuthConfiguration } from "./config.js";

export const exampleRuntimeAuthConfiguration: RuntimeAuthConfiguration = {
  config_version: 1,
  issuers: [
    {
      issuer: "https://issuer.example",
      jwks_uri: "https://issuer.example/.well-known/jwks.json",
      audiences: ["control-plane"],
      allowed_algorithms: ["RS256"],
      clock_skew_seconds: 30
    }
  ],
  principals: [
    {
      issuer: "https://issuer.example",
      subject: "example-service",
      principal_id: "principal://example/service",
      actor: { type: "service", id: "example-service" },
      roles: ["work.submitter"]
    },
    {
      issuer: "https://issuer.example",
      subject: "example-operator",
      principal_id: "principal://example/operator",
      actor: { type: "user", id: "example-operator" },
      roles: ["work.submitter"]
    }
  ],
  roles: [
    {
      name: "work.submitter",
      grants: [
        {
          authorization_action: "state.reconcile",
          resources: [{ type: "example.environment", id: "*" }]
        },
        {
          authorization_action: "runtime.event.ingest",
          resources: [{ type: "example.environment", id: "*" }]
        },
        {
          authorization_action: "runtime.work-item.create",
          resources: [{ type: "example.environment", id: "*" }]
        },
        {
          authorization_action: "runtime.command.approve",
          resources: [{ type: "example.environment", id: "*" }]
        },
        {
          authorization_action: "runtime.record.read",
          resources: [
            { type: "runtime.record", id: "*" },
            { type: "runtime.stream", id: "*" },
            { type: "runtime.projection", id: "*" },
            { type: "runtime.audit", id: "*" },
            { type: "runtime.registry", id: "*" }
          ]
        }
      ]
    }
  ],
  delegations: [
    {
      authenticated_principal_id: "principal://example/service",
      on_behalf_of_principal_id: "principal://example/operator",
      allowed_authorization_actions: ["state.reconcile"]
    }
  ],
  authorization_policy: {
    provider: "static-rbac-v1",
    policy_version: "example-policy-v1"
  }
};
