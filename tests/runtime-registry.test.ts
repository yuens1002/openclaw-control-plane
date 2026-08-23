import { describe, expect, it } from "vitest";

import {
  RuntimeTypeRegistry,
  exampleOperationRegistrations,
  exampleTypeRegistrations
} from "@openclaw-control-plane/db";

describe("runtime type registry", () => {
  it("loads workflow-neutral example fixtures", () => {
    const registry = new RuntimeTypeRegistry(
      exampleTypeRegistrations,
      exampleOperationRegistrations
    );

    expect(registry.requireType("event", "example.observation", 1).status).toBe("active");
    expect(registry.requireOperation("example.state.reconcile", 1).handler_id).toBe(
      "example-reconcile-handler"
    );
    expect(registry.listTypes().every((item) => item.type.startsWith("example."))).toBe(true);
  });

  it("treats an identical registration as idempotent", () => {
    const registry = new RuntimeTypeRegistry();
    const registration = exampleTypeRegistrations[0]!;

    registry.registerType(registration);
    registry.registerType({ ...registration });

    expect(registry.listTypes()).toHaveLength(1);
  });

  it("rejects a conflicting registration", () => {
    const registry = new RuntimeTypeRegistry();
    const registration = exampleTypeRegistrations[0]!;
    registry.registerType(registration);

    expect(() =>
      registry.registerType({
        ...registration,
        payload_schema: {
          type: "object",
          required: ["different"],
          properties: { different: { type: "string" } }
        }
      })
    ).toThrow(/conflicts/i);
  });

  it("rejects operation behavior changes under an existing versioned key", () => {
    const registry = new RuntimeTypeRegistry([], exampleOperationRegistrations);
    const registration = exampleOperationRegistrations[0]!;

    expect(() =>
      registry.registerOperation({
        ...registration,
        handler_id: "replacement-handler"
      })
    ).toThrow(/conflicts/i);
    expect(() =>
      registry.registerOperation({
        ...registration,
        allowed_result_types: ["example.report"]
      })
    ).toThrow(/conflicts/i);
  });

  it("blocks new writes after retirement while preserving historical lookup", () => {
    const registry = new RuntimeTypeRegistry(exampleTypeRegistrations);
    const registration = exampleTypeRegistrations[0]!;

    registry.retireType(registration.kind, registration.type, registration.schema_version);

    expect(
      registry.getType(registration.kind, registration.type, registration.schema_version)?.status
    ).toBe("retired");
    expect(() =>
      registry.validatePayload(
        registration.kind,
        registration.type,
        registration.schema_version,
        { statement: "new write" }
      )
    ).toThrow(/retired/i);
  });

  it("validates payloads with JSON Schema 2020-12", () => {
    const registry = new RuntimeTypeRegistry(exampleTypeRegistrations);

    expect(() =>
      registry.validatePayload("event", "example.observation", 1, {
        statement: "A material fact changed."
      })
    ).not.toThrow();
    expect(() =>
      registry.validatePayload("event", "example.observation", 1, {})
    ).toThrow(/payload/i);
  });
});
