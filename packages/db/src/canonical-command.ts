import { createHash } from "node:crypto";
import canonicalizeModule from "canonicalize";

const canonicalizeJson = canonicalizeModule as unknown as (input: unknown) => string | undefined;

export interface CanonicalCommand {
  canonicalization_version: string;
  operation_type: string;
  operation_schema_version: number;
  work_item_id: string;
  action_revision: number;
  target: { type: string; id: string };
  arguments: unknown;
  declared_effects: readonly unknown[];
}

export interface StoredCommandIdentity {
  canonicalization_version: string;
  command_digest: string;
}

export function canonicalizeCommand(command: CanonicalCommand): string {
  const serialized = canonicalizeJson(command);
  if (serialized === undefined) {
    throw new TypeError("Command cannot be represented as canonical JSON.");
  }
  return serialized;
}

export function commandDigest(command: CanonicalCommand): string {
  return `sha256:${createHash("sha256").update(canonicalizeCommand(command), "utf8").digest("hex")}`;
}

export function compareIdempotencyCommand(
  stored: StoredCommandIdentity,
  candidate: StoredCommandIdentity
): "equal" | "conflict" {
  return stored.canonicalization_version === candidate.canonicalization_version &&
    stored.command_digest === candidate.command_digest
    ? "equal"
    : "conflict";
}
