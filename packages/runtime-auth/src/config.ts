import {
  EffectiveActorSchema,
  SafeLocalIdentifierSchema,
  SafeNamespacedIdentifierSchema
} from "@openclaw-control-plane/contracts";
import { z } from "zod";

const PrincipalRefSchema = z
  .string()
  .min(13)
  .max(512)
  .regex(/^principal:\/\/[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

export const RuntimeEnvironmentSchema = z.enum(["development", "test", "production"]);
export type RuntimeEnvironment = z.infer<typeof RuntimeEnvironmentSchema>;

export const IssuerConfigurationSchema = z
  .object({
    issuer: z.string().url().max(2048),
    jwks_uri: z.string().url().max(2048),
    audiences: z.array(z.string().min(1).max(256)).min(1),
    allowed_algorithms: z
      .array(z.enum(["RS256", "RS384", "RS512", "ES256", "ES384", "ES512", "EdDSA"]))
      .min(1),
    clock_skew_seconds: z.number().int().min(0).max(300)
  })
  .strict();
export type IssuerConfiguration = z.infer<typeof IssuerConfigurationSchema>;

const ResourceGrantSchema = z
  .object({
    type: SafeNamespacedIdentifierSchema,
    id: z.union([SafeLocalIdentifierSchema, z.literal("*")])
  })
  .strict();

export const RoleConfigurationSchema = z
  .object({
    name: SafeNamespacedIdentifierSchema,
    grants: z
      .array(
        z
          .object({
            authorization_action: SafeNamespacedIdentifierSchema,
            resources: z.array(ResourceGrantSchema).min(1)
          })
          .strict()
      )
      .min(1)
  })
  .strict();
export type RoleConfiguration = z.infer<typeof RoleConfigurationSchema>;

export const PrincipalConfigurationSchema = z
  .object({
    issuer: z.string().url().max(2048),
    subject: z.string().min(1).max(512),
    principal_id: PrincipalRefSchema,
    actor: EffectiveActorSchema,
    roles: z.array(SafeNamespacedIdentifierSchema)
  })
  .strict();
export type PrincipalConfiguration = z.infer<typeof PrincipalConfigurationSchema>;

export const DelegationConfigurationSchema = z
  .object({
    authenticated_principal_id: PrincipalRefSchema,
    on_behalf_of_principal_id: PrincipalRefSchema,
    allowed_authorization_actions: z.array(SafeNamespacedIdentifierSchema).min(1)
  })
  .strict();
export type DelegationConfiguration = z.infer<typeof DelegationConfigurationSchema>;

export const RuntimeAuthConfigurationSchema = z
  .object({
    config_version: z.literal(1),
    issuers: z.array(IssuerConfigurationSchema),
    principals: z.array(PrincipalConfigurationSchema),
    roles: z.array(RoleConfigurationSchema),
    delegations: z.array(DelegationConfigurationSchema).default([]),
    authorization_policy: z
      .object({
        provider: z.literal("static-rbac-v1"),
        policy_version: SafeLocalIdentifierSchema
      })
      .strict(),
    development_basic_auth: z
      .object({
        enabled: z.boolean()
      })
      .strict()
      .optional()
  })
  .strict()
  .superRefine((config, context) => {
    findDuplicates(config.issuers.map((issuer) => issuer.issuer)).forEach((issuer) =>
      addIssue(context, ["issuers"], `Duplicate issuer: ${issuer}`)
    );
    for (const issuer of config.issuers) {
      findDuplicates(issuer.audiences).forEach((audience) =>
        addIssue(context, ["issuers"], `Duplicate audience for issuer: ${audience}`)
      );
      findDuplicates(issuer.allowed_algorithms).forEach((algorithm) =>
        addIssue(context, ["issuers"], `Duplicate algorithm for issuer: ${algorithm}`)
      );
    }

    const externalIdentities = config.principals.map(
      (principal) => `${principal.issuer}\u0000${principal.subject}`
    );
    findDuplicates(externalIdentities).forEach(() =>
      addIssue(context, ["principals"], "Duplicate external identity mapping.")
    );
    findDuplicates(config.principals.map((principal) => principal.principal_id)).forEach(
      (principalId) =>
        addIssue(context, ["principals"], `Duplicate principal ID: ${principalId}`)
    );
    findDuplicates(config.roles.map((role) => role.name)).forEach((role) =>
      addIssue(context, ["roles"], `Duplicate role: ${role}`)
    );

    const issuers = new Set(config.issuers.map((issuer) => issuer.issuer));
    const roles = new Set(config.roles.map((role) => role.name));
    const principals = new Set(config.principals.map((principal) => principal.principal_id));
    for (const principal of config.principals) {
      if (!issuers.has(principal.issuer)) {
        addIssue(context, ["principals"], "Principal references an unknown issuer.");
      }
      for (const role of principal.roles) {
        if (!roles.has(role)) {
          addIssue(context, ["principals"], `Principal references an unknown role: ${role}`);
        }
      }
    }
    for (const delegation of config.delegations) {
      if (!principals.has(delegation.authenticated_principal_id)) {
        addIssue(context, ["delegations"], "Delegation references an unknown authenticated principal.");
      }
      if (!principals.has(delegation.on_behalf_of_principal_id)) {
        addIssue(context, ["delegations"], "Delegation references an unknown target principal.");
      }
    }
  });
export type RuntimeAuthConfiguration = z.infer<typeof RuntimeAuthConfigurationSchema>;

export function parseRuntimeAuthConfiguration(
  input: unknown,
  environment: RuntimeEnvironment
): RuntimeAuthConfiguration {
  const parsedEnvironment = RuntimeEnvironmentSchema.parse(environment);
  const config = RuntimeAuthConfigurationSchema.parse(input);
  if (parsedEnvironment === "production") {
    if (config.development_basic_auth?.enabled) {
      throw new Error("Development Basic Authentication cannot be enabled in production.");
    }
    if (config.issuers.length === 0 || config.principals.length === 0) {
      throw new Error("Production authentication requires an issuer and principal mapping.");
    }
  }
  return config;
}

function findDuplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function addIssue(context: z.RefinementCtx, path: (string | number)[], message: string) {
  context.addIssue({ code: z.ZodIssueCode.custom, path, message });
}
