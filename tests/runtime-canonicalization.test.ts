import { describe, expect, it } from "vitest";

import {
  canonicalizeCommand,
  commandDigest,
  compareIdempotencyCommand
} from "@openclaw-control-plane/db";

describe("runtime command canonicalization", () => {
  const command = {
    canonicalization_version: "jcs-rfc8785-v1" as const,
    operation_type: "example.state.reconcile",
    operation_schema_version: 1,
    work_item_id: "00000000-0000-4000-8000-000000000101",
    action_revision: 1,
    target: { type: "example.environment", id: "production" },
    arguments: { desired: { b: 2, a: 1 } },
    declared_effects: [
      {
        result_type: "example.reconciliation.delta",
        schema_version: 1,
        schema_ref: "example://schemas/reconciliation-delta/v1",
        target: { type: "example.environment", id: "production" },
        payload: { changed: true }
      }
    ]
  };

  it("uses RFC 8785 ordering independently of object insertion order", () => {
    const reordered = {
      ...command,
      arguments: { desired: { a: 1, b: 2 } }
    };

    expect(canonicalizeCommand(command)).toBe(canonicalizeCommand(reordered));
    expect(commandDigest(command)).toBe(commandDigest(reordered));
  });

  it.each([
    ["target", { ...command, target: { ...command.target, id: "staging" } }],
    ["arguments", { ...command, arguments: { desired: { a: 1, b: 3 } } }],
    [
      "declared effects",
      {
        ...command,
        declared_effects: [
          { ...command.declared_effects[0]!, payload: { changed: false } }
        ]
      }
    ]
  ])("changes the digest when %s change", (_name, changedCommand) => {
    expect(commandDigest(changedCommand)).not.toBe(commandDigest(command));
  });

  it("keeps idempotency identity separate from digest comparison", () => {
    const stored = {
      canonicalization_version: command.canonicalization_version,
      command_digest: commandDigest(command)
    };

    expect(compareIdempotencyCommand(stored, stored)).toBe("equal");
    expect(
      compareIdempotencyCommand(stored, {
        ...stored,
        command_digest: commandDigest({ ...command, action_revision: 2 })
      })
    ).toBe("conflict");
    expect(
      compareIdempotencyCommand(stored, {
        ...stored,
        canonicalization_version: "future-version"
      })
    ).toBe("conflict");
  });
});
