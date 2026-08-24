import { createHash } from "node:crypto";

import Ajv2020Module, { type ValidateFunction } from "ajv/dist/2020.js";
import canonicalizeModule from "canonicalize";

const canonicalizeJson = canonicalizeModule as unknown as (input: unknown) => string | undefined;
const Ajv2020 = Ajv2020Module as unknown as new (options: {
  allErrors: boolean;
  strict: boolean;
}) => {
  compile(schema: Record<string, unknown>): ValidateFunction;
  errorsText(errors?: ValidateFunction["errors"]): string;
};

export type RegisteredRuntimeKind = "event" | "work_item" | "result" | "artifact";
export type RegistrationStatus = "active" | "retired";

export interface RuntimeTypeRegistration {
  kind: RegisteredRuntimeKind;
  type: string;
  schema_version: number;
  schema_ref: string;
  payload_schema: Record<string, unknown>;
  status: RegistrationStatus;
  owner: string;
  schema_digest?: string;
}

export interface RuntimeOperationRegistration {
  operation_type: string;
  command_schema_version: number;
  command_schema_ref: string;
  command_schema: Record<string, unknown>;
  allowed_result_types: readonly string[];
  handler_id: string;
  handler_version: number;
  authorization_action: string;
  approval_required: boolean;
  status: RegistrationStatus;
  command_schema_digest?: string;
}

interface StoredTypeRegistration extends RuntimeTypeRegistration {
  schema_digest: string;
  validator: ValidateFunction;
}

interface StoredOperationRegistration extends RuntimeOperationRegistration {
  command_schema_digest: string;
  validator: ValidateFunction;
}

export class RuntimeTypeRegistry {
  private readonly ajv = new Ajv2020({ allErrors: true, strict: true });
  private readonly types = new Map<string, StoredTypeRegistration>();
  private readonly operations = new Map<string, StoredOperationRegistration>();

  constructor(
    types: readonly RuntimeTypeRegistration[] = [],
    operations: readonly RuntimeOperationRegistration[] = []
  ) {
    for (const registration of types) this.registerType(registration);
    for (const registration of operations) this.registerOperation(registration);
  }

  registerType(registration: RuntimeTypeRegistration): void {
    const key = typeKey(registration.kind, registration.type, registration.schema_version);
    const computedDigest = digestJson(registration.payload_schema);
    if (
      registration.schema_digest !== undefined &&
      registration.schema_digest !== computedDigest
    ) {
      throw new Error(`Type registration ${key} supplied an invalid schema digest.`);
    }
    const digest = computedDigest;
    const existing = this.types.get(key);
    if (existing) {
      if (
        existing.schema_digest !== digest ||
        existing.schema_ref !== registration.schema_ref ||
        existing.owner !== registration.owner
      ) {
        throw new Error(`Type registration ${key} conflicts with an existing schema.`);
      }
      return;
    }
    this.types.set(key, {
      ...registration,
      schema_digest: digest,
      validator: this.ajv.compile(registration.payload_schema)
    });
  }

  registerOperation(registration: RuntimeOperationRegistration): void {
    const key = operationKey(registration.operation_type, registration.command_schema_version);
    const computedDigest = digestJson(registration.command_schema);
    if (
      registration.command_schema_digest !== undefined &&
      registration.command_schema_digest !== computedDigest
    ) {
      throw new Error(`Operation registration ${key} supplied an invalid schema digest.`);
    }
    const digest = computedDigest;
    const existing = this.operations.get(key);
    if (existing) {
      if (
        existing.command_schema_digest !== digest ||
        existing.command_schema_ref !== registration.command_schema_ref ||
        existing.handler_id !== registration.handler_id ||
        existing.handler_version !== registration.handler_version ||
        existing.authorization_action !== registration.authorization_action ||
        existing.approval_required !== registration.approval_required ||
        !sameStrings(existing.allowed_result_types, registration.allowed_result_types)
      ) {
        throw new Error(`Operation registration ${key} conflicts with an existing schema.`);
      }
      return;
    }
    this.operations.set(key, {
      ...registration,
      command_schema_digest: digest,
      validator: this.ajv.compile(registration.command_schema)
    });
  }

  getType(
    kind: RegisteredRuntimeKind,
    type: string,
    schemaVersion: number
  ): RuntimeTypeRegistration | undefined {
    const stored = this.types.get(typeKey(kind, type, schemaVersion));
    return stored ? publicTypeRegistration(stored) : undefined;
  }

  requireType(
    kind: RegisteredRuntimeKind,
    type: string,
    schemaVersion: number
  ): RuntimeTypeRegistration {
    const registration = this.getType(kind, type, schemaVersion);
    if (!registration) throw new Error(`Type registration ${typeKey(kind, type, schemaVersion)} is missing.`);
    return registration;
  }

  requireOperation(operationType: string, schemaVersion: number): RuntimeOperationRegistration {
    const stored = this.operations.get(operationKey(operationType, schemaVersion));
    if (!stored) {
      throw new Error(`Operation registration ${operationKey(operationType, schemaVersion)} is missing.`);
    }
    return publicOperationRegistration(stored);
  }

  retireType(kind: RegisteredRuntimeKind, type: string, schemaVersion: number): void {
    const key = typeKey(kind, type, schemaVersion);
    const registration = this.types.get(key);
    if (!registration) throw new Error(`Type registration ${key} is missing.`);
    registration.status = "retired";
  }

  retireOperation(operationType: string, schemaVersion: number): void {
    const key = operationKey(operationType, schemaVersion);
    const registration = this.operations.get(key);
    if (!registration) throw new Error(`Operation registration ${key} is missing.`);
    registration.status = "retired";
  }

  validatePayload(
    kind: RegisteredRuntimeKind,
    type: string,
    schemaVersion: number,
    payload: unknown
  ): void {
    const key = typeKey(kind, type, schemaVersion);
    const registration = this.types.get(key);
    if (!registration) throw new Error(`Type registration ${key} is missing.`);
    if (registration.status !== "active") throw new Error(`Type registration ${key} is retired.`);
    if (!registration.validator(payload)) {
      throw new Error(`Payload failed ${key}: ${this.ajv.errorsText(registration.validator.errors)}.`);
    }
  }

  validateHistoricalPayload(
    kind: RegisteredRuntimeKind,
    type: string,
    schemaVersion: number,
    schemaRef: string,
    payload: unknown
  ): void {
    const key = typeKey(kind, type, schemaVersion);
    const registration = this.types.get(key);
    if (!registration) throw new Error(`Type registration ${key} is missing during replay.`);
    if (registration.schema_ref !== schemaRef) {
      throw new Error(`Schema reference for ${key} changed during replay.`);
    }
    if (!registration.validator(payload)) {
      throw new Error(
        `Historical payload failed ${key}: ${this.ajv.errorsText(registration.validator.errors)}.`
      );
    }
  }

  validateCommand(operationType: string, schemaVersion: number, command: unknown): void {
    const key = operationKey(operationType, schemaVersion);
    const registration = this.operations.get(key);
    if (!registration) throw new Error(`Operation registration ${key} is missing.`);
    if (registration.status !== "active") throw new Error(`Operation registration ${key} is retired.`);
    if (!registration.validator(command)) {
      throw new Error(`Command failed ${key}: ${this.ajv.errorsText(registration.validator.errors)}.`);
    }
  }

  listTypes(): RuntimeTypeRegistration[] {
    return [...this.types.values()].map(publicTypeRegistration);
  }

  listOperations(): RuntimeOperationRegistration[] {
    return [...this.operations.values()].map(publicOperationRegistration);
  }
}

export const exampleTypeRegistrations: readonly RuntimeTypeRegistration[] = [
  {
    kind: "event",
    type: "example.observation",
    schema_version: 1,
    schema_ref: "example://schemas/observation/v1",
    payload_schema: {
      type: "object",
      additionalProperties: false,
      required: ["statement"],
      properties: { statement: { type: "string", minLength: 1 } }
    },
    status: "active",
    owner: "example"
  },
  {
    kind: "work_item",
    type: "example.state.reconcile",
    schema_version: 1,
    schema_ref: "example://schemas/state-reconcile/v1",
    payload_schema: {
      type: "object",
      additionalProperties: false,
      properties: { requested_state: { type: "object" } }
    },
    status: "active",
    owner: "example"
  },
  {
    kind: "result",
    type: "example.reconciliation.delta",
    schema_version: 1,
    schema_ref: "example://schemas/reconciliation-delta/v1",
    payload_schema: {
      type: "object",
      additionalProperties: false,
      required: ["changed"],
      properties: { changed: { type: "boolean" } }
    },
    status: "active",
    owner: "example"
  },
  {
    kind: "artifact",
    type: "example.report",
    schema_version: 1,
    schema_ref: "example://schemas/report/v1",
    payload_schema: {
      type: "object",
      additionalProperties: false,
      required: ["content_ref"],
      properties: { content_ref: { type: "string", minLength: 1 } }
    },
    status: "active",
    owner: "example"
  }
] as const;

export const runtimeTypeRegistrations: readonly RuntimeTypeRegistration[] = [
  {
    kind: "event",
    type: "runtime.ingested_event",
    schema_version: 1,
    schema_ref: "runtime://schemas/ingested-event/v1",
    payload_schema: {
      type: "object",
      additionalProperties: false,
      required: [
        "event_type",
        "source",
        "reported_actor",
        "reported_subject",
        "sensitivity",
        "data"
      ],
      properties: {
        event_type: { type: "string" },
        source: { type: "string" },
        reported_actor: { type: "object" },
        reported_subject: { type: "object" },
        sensitivity: { enum: ["public", "business", "private"] },
        data: { type: "object" }
      }
    },
    status: "active",
    owner: "runtime"
  }
] as const;

export const legacyTypeRegistrations: readonly RuntimeTypeRegistration[] = [
  ["event", "legacy.event", "legacy://schemas/event/v1"],
  ["work_item", "legacy.work_item", "legacy://schemas/work-item/v1"],
  ["result", "legacy.result", "legacy://schemas/result/v1"],
  ["artifact", "legacy.artifact", "legacy://schemas/artifact/v1"]
].map(([kind, type, schemaRef]) => ({
  kind: kind as RegisteredRuntimeKind,
  type: type!,
  schema_version: 1,
  schema_ref: schemaRef!,
  payload_schema: {},
  status: "retired" as const,
  owner: "platform"
}));

export const exampleOperationRegistrations: readonly RuntimeOperationRegistration[] = [
  {
    operation_type: "example.state.reconcile",
    command_schema_version: 1,
    command_schema_ref: "example://schemas/reconcile-command/v1",
    command_schema: {
      type: "object",
      additionalProperties: false,
      properties: { desired: { type: "object" } }
    },
    allowed_result_types: ["example.reconciliation.delta"],
    handler_id: "example-reconcile-handler",
    handler_version: 1,
    authorization_action: "state.reconcile",
    approval_required: false,
    status: "active"
  },
  {
    operation_type: "example.state.reconcile_with_approval",
    command_schema_version: 1,
    command_schema_ref: "example://schemas/reconcile-command/v1",
    command_schema: {
      type: "object",
      additionalProperties: false,
      properties: { desired: { type: "object" } }
    },
    allowed_result_types: ["example.reconciliation.delta"],
    handler_id: "example-reconcile-handler",
    handler_version: 1,
    authorization_action: "state.reconcile",
    approval_required: true,
    status: "active"
  }
] as const;

export const legacyOperationRegistrations: readonly RuntimeOperationRegistration[] = [
  ["legacy.worker_run", "legacy://schemas/worker-run-command/v1", "legacy.execute"],
  ["legacy.approval.resolve", "legacy://schemas/approval-command/v1", "legacy.approve"],
  ["legacy.audit", "legacy://schemas/audit-command/v1", "legacy.audit"],
  ["legacy.tool.invoke", "legacy://schemas/tool-command/v1", "legacy.tool.invoke"]
].map(([operationType, schemaRef, authorizationAction]) => ({
  operation_type: operationType!,
  command_schema_version: 1,
  command_schema_ref: schemaRef!,
  command_schema: {},
  allowed_result_types: [],
  handler_id: "legacy-handler",
  handler_version: 1,
  authorization_action: authorizationAction!,
  approval_required: false,
  status: "retired" as const
}));

function typeKey(kind: RegisteredRuntimeKind, type: string, version: number): string {
  return `${kind}:${type}:${version}`;
}

function operationKey(type: string, version: number): string {
  return `${type}:${version}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function digestJson(value: unknown): string {
  const canonical = canonicalizeJson(value);
  if (canonical === undefined) throw new TypeError("Schema cannot be represented as canonical JSON.");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function publicTypeRegistration(stored: StoredTypeRegistration): RuntimeTypeRegistration {
  const { validator: _validator, ...registration } = stored;
  return registration;
}

function publicOperationRegistration(
  stored: StoredOperationRegistration
): RuntimeOperationRegistration {
  const { validator: _validator, ...registration } = stored;
  return registration;
}
