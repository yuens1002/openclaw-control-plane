import { randomUUID } from "node:crypto";

import {
  RuntimeSubjectSchema,
  TrustedCommandContextSchema,
  type RuntimeSubject,
  type TrustedCommandContext
} from "@openclaw-control-plane/contracts";

import type { AuthenticatedPrincipal } from "./authentication.js";
import type {
  DelegationConfiguration,
  PrincipalConfiguration,
  RoleConfiguration,
  RuntimeAuthConfiguration
} from "./config.js";

export interface AuthorizationRequest {
  authenticated_principal: AuthenticatedPrincipal;
  on_behalf_of_principal_id?: string;
  action: string;
  resource: RuntimeSubject;
  request_origin: TrustedCommandContext["request_origin"];
}

export interface AuthorizationDecision {
  decision_id: string;
  result: "allowed" | "denied";
  policy_version: string;
  reason_codes: string[];
}

export interface AuthorizationProvider {
  authorize(request: AuthorizationRequest): AuthorizationDecision;
}

export interface StaticRbacOptions {
  createDecisionId?: () => string;
}

export class StaticRbacAuthorizationProvider implements AuthorizationProvider {
  private readonly roles: Map<string, RoleConfiguration>;
  private readonly principals: Map<string, PrincipalConfiguration>;
  private readonly delegations: DelegationConfiguration[];
  private readonly createDecisionId: () => string;

  constructor(private readonly config: RuntimeAuthConfiguration, options: StaticRbacOptions = {}) {
    this.roles = new Map(config.roles.map((role) => [role.name, role]));
    this.principals = new Map(
      config.principals.map((principal) => [principal.principal_id, principal])
    );
    this.delegations = config.delegations;
    this.createDecisionId = options.createDecisionId ?? randomUUID;
  }

  authorize(request: AuthorizationRequest): AuthorizationDecision {
    const resource = RuntimeSubjectSchema.parse(request.resource);
    const principal = this.principals.get(
      request.authenticated_principal.principal.principal_id
    );
    if (!principal) return this.decision("denied", ["policy.unknown_principal"]);
    const roleAllows = principal.roles.some((roleName) =>
      this.roles.get(roleName)?.grants.some(
        (grant) =>
          grant.authorization_action === request.action &&
          grant.resources.some(
            (candidate) =>
              candidate.type === resource.type &&
              (candidate.id === "*" || candidate.id === resource.id)
          )
      )
    );
    if (!roleAllows) return this.decision("denied", ["policy.no_matching_grant"]);

    if (request.on_behalf_of_principal_id) {
      const target = this.principals.get(request.on_behalf_of_principal_id);
      if (!target) return this.decision("denied", ["policy.invalid_delegation_target"]);
      const delegationAllows = this.delegations.some(
        (delegation) =>
          delegation.authenticated_principal_id === principal.principal_id &&
          delegation.on_behalf_of_principal_id === request.on_behalf_of_principal_id &&
          delegation.allowed_authorization_actions.includes(request.action)
      );
      if (!delegationAllows) return this.decision("denied", ["policy.delegation_not_allowed"]);
    }
    return this.decision("allowed", ["policy.allowed"]);
  }

  resolvePrincipal(principalId: string): PrincipalConfiguration | undefined {
    return this.principals.get(principalId);
  }

  private decision(result: AuthorizationDecision["result"], reasonCodes: string[]) {
    return {
      decision_id: this.createDecisionId(),
      result,
      policy_version: this.config.authorization_policy.policy_version,
      reason_codes: reasonCodes
    };
  }
}

export class TrustedContextCoordinator {
  constructor(private readonly provider: AuthorizationProvider & {
    resolvePrincipal?: (principalId: string) => PrincipalConfiguration | undefined;
  }) {}

  authorize(request: AuthorizationRequest): TrustedCommandContext {
    const decision = this.provider.authorize(request);
    const delegated = request.on_behalf_of_principal_id
      ? this.provider.resolvePrincipal?.(request.on_behalf_of_principal_id)
      : undefined;
    return TrustedCommandContextSchema.parse({
      authenticated_principal_ref: request.authenticated_principal.principal.principal_id,
      effective_actor: delegated?.actor ?? request.authenticated_principal.principal.actor,
      ...(request.on_behalf_of_principal_id
        ? { on_behalf_of_principal_ref: request.on_behalf_of_principal_id }
        : {}),
      request_origin: request.request_origin,
      authorization: {
        decision_id: decision.decision_id,
        action: request.action,
        result: decision.result,
        policy_version: decision.policy_version,
        reason_codes: decision.reason_codes
      }
    });
  }
}
