import { describe, expect, it } from "vitest";

import { createControlPlaneApp } from "@openclaw-control-plane/api";
import { InMemoryEventStore } from "@openclaw-control-plane/db";

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
