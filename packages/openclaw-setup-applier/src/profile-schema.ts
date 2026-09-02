import { z } from "zod";

// This schema was validated against two real generated profiles (a managed
// and a BYOK tier) from a private agency/client profile repo — see the
// "Hard blocker" entry in docs/plans/setup-profile-applier/plan.md's
// Dependencies section, now resolved. The initial reconstruction from
// GitHub issue #7's prose got the model-provider shape right but invented
// a `nonSecretConfig.channelType` nesting for channels that doesn't exist
// in real profiles — channels carry `type` as a top-level field instead.
// Every object below is `.passthrough()`: an unrecognized field must never
// break parsing, since this repo does not control (and must not assume)
// the shape of every private profile generator that might produce one.
// Only the fields this applier actually consumes are validated, and a
// missing consumed field fails loud with its exact path.

const KeyProvisioningSchema = z
  .object({
    method: z.literal("openrouter-provisioning-api"),
    spendLimitUsd: z.number().positive(),
    limitReset: z.string().min(1)
  })
  .passthrough();

const ModelProviderNonSecretConfigSchema = z
  .object({
    authGroup: z.string().min(1),
    authChoice: z.string().min(1),
    flow: z.enum(["quickstart", "advanced", "manual"]),
    keyProvisioning: KeyProvisioningSchema.optional(),
    // Advanced custom-provider path (issue #7): names an env var the
    // *running OpenClaw process* must resolve itself, rather than a value
    // sent directly in the /setup/api/run payload. Not exercised by either
    // real profile validated so far — modeled from issue #7's prose only.
    customProviderApiKeyEnv: z.string().min(1).optional()
  })
  .passthrough();

const ModelProviderAttachmentSchema = z
  .object({
    nonSecretConfig: ModelProviderNonSecretConfigSchema,
    requiredSecretNames: z.array(z.string().min(1))
  })
  .passthrough();

const ChannelAttachmentSchema = z
  .object({
    type: z.string().min(1),
    requiredSecretNames: z.array(z.string().min(1))
  })
  .passthrough();

// Finding 1.7 (product-separation findings-and-decisions.md): a profile could
// not express an MCP server as an attachment. This closes that gap for any
// generic MCP server — this schema stays consumer-agnostic on purpose, the
// same way ChannelAttachmentSchema's `type` is a free string rather than an
// enum of known channel names: no server name (e.g. a specific runtime
// engine) is hardcoded here. `transport` is likewise a free string (e.g.
// "http", "sse", "stdio") rather than an enum, for the same reason. `url` is
// optional because a locally-launched (stdio) server has no network endpoint
// to declare.
const McpServerAttachmentSchema = z
  .object({
    name: z.string().min(1),
    transport: z.string().min(1),
    url: z.string().min(1).optional(),
    requiredSecretNames: z.array(z.string().min(1))
  })
  .passthrough();

const AttachmentsSchema = z
  .object({
    modelProviders: z.array(ModelProviderAttachmentSchema).default([]),
    channels: z.array(ChannelAttachmentSchema).default([]),
    mcpServers: z.array(McpServerAttachmentSchema).default([])
  })
  .passthrough();

export const ClientProfileSchema = z
  .object({
    attachments: AttachmentsSchema
  })
  .passthrough();

export type KeyProvisioning = z.infer<typeof KeyProvisioningSchema>;
export type ModelProviderAttachment = z.infer<typeof ModelProviderAttachmentSchema>;
export type ChannelAttachment = z.infer<typeof ChannelAttachmentSchema>;
export type McpServerAttachment = z.infer<typeof McpServerAttachmentSchema>;
export type ClientProfile = z.infer<typeof ClientProfileSchema>;

/**
 * Parses a candidate client profile. Throws an Error naming the exact
 * field path when a field this applier consumes is missing or malformed;
 * never throws for a field it doesn't consume.
 */
export function parseClientProfile(candidateProfile: unknown): ClientProfile {
  const result = ClientProfileSchema.safeParse(candidateProfile);
  if (result.success) {
    return result.data;
  }

  const issue = result.error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join(".") : "(root)";
  const message = issue?.message ?? "Invalid client profile.";
  throw new Error(`Invalid client profile at '${path}': ${message}`);
}
