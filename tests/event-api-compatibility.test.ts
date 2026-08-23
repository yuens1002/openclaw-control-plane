import { describe, expect, it } from "vitest";

import { createControlPlaneApp } from "@openclaw-control-plane/api";
import { InMemoryEventStore } from "@openclaw-control-plane/db";
import type {
  EventEnvelope,
  TrustedCommandContext
} from "@openclaw-control-plane/contracts";

describe("POST /events compatibility", () => {
  it("preserves inserted and duplicate response behavior through the store boundary", async () => {
    const app = createControlPlaneApp({ eventStore: new InMemoryEventStore() });
    const event = fixture();

    const inserted = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event)
    });
    const duplicate = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...event,
        event_id: "00000000-0000-4000-8000-000000003002"
      })
    });

    expect(inserted.status).toBe(202);
    expect(await inserted.json()).toMatchObject({ status: "inserted", event });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toMatchObject({
      status: "duplicate",
      event: { event_id: event.event_id }
    });
  });

  it("rejects malformed envelopes before calling persistence", async () => {
    const eventStore = {
      insertEventIfNew: async () => {
        throw new Error("persistence must not be called");
      },
      getEventByIdempotencyKey: async () => null
    };
    const app = createControlPlaneApp({ eventStore });
    const response = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...fixture(), idempotency_key: "short" })
    });

    expect(response.status).toBe(400);
  });

  it("injects server-derived HTTP command context into persistence", async () => {
    let receivedContext: TrustedCommandContext | undefined;
    const eventStore = {
      insertEventIfNew: async (event: EventEnvelope, context?: TrustedCommandContext) => {
        receivedContext = context;
        return { status: "inserted" as const, event };
      },
      getEventByIdempotencyKey: async () => null
    };
    const commandContext: TrustedCommandContext = {
      authenticated_principal_ref: "principal://service/api-test",
      effective_actor: { type: "service", id: "api-test" },
      request_origin: "http",
      authorization: {
        decision_id: "api-event-ingest-001",
        action: "runtime.event.ingest",
        result: "allowed",
        policy_version: "test-policy-v1",
        reason_codes: ["runtime.test_ingest"]
      }
    };
    const app = createControlPlaneApp({
      eventStore,
      eventCommandContext: () => commandContext
    });

    const response = await app.request("/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(fixture())
    });

    expect(response.status).toBe(202);
    expect(receivedContext).toEqual(commandContext);
  });
});

function fixture() {
  return {
    event_id: "00000000-0000-4000-8000-000000003001",
    event_type: "example.lead_created",
    occurred_at: "2026-08-23T12:00:00.000Z",
    source: "api-fixture",
    domain: "example-workflow",
    actor: { type: "user", id: "user-123" },
    subject: { type: "lead", id: "lead-123" },
    sensitivity: "business",
    idempotency_key: "api-event-key-3001",
    payload: { name: "Example Lead" }
  };
}
