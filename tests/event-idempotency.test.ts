import { describe, expect, it } from "vitest";
import { InMemoryEventStore } from "@openclaw-control-plane/db";
import { parseEventEnvelope } from "@openclaw-control-plane/contracts";

describe("event idempotency", () => {
  it("inserts an event once for a given idempotency key", async () => {
    const eventStore = new InMemoryEventStore();
    const eventEnvelope = parseEventEnvelope({
      event_id: "00000000-0000-4000-8000-000000001001",
      event_type: "example.lead_created",
      occurred_at: "2026-08-13T12:00:00.000Z",
      source: "manual_fixture",
      domain: "example-workflow",
      actor: {
        type: "user",
        id: "user_123"
      },
      subject: {
        type: "lead",
        id: "lead_123"
      },
      sensitivity: "business",
      idempotency_key: "example-workflow-lead-123",
      payload: {
        subject: "North Loop Studio"
      }
    });

    const firstInsert = await eventStore.insertEventIfNew(eventEnvelope);
    const secondInsert = await eventStore.insertEventIfNew({
      ...eventEnvelope,
      event_id: "00000000-0000-4000-8000-000000001002"
    });

    expect(firstInsert.status).toBe("inserted");
    expect(secondInsert.status).toBe("duplicate");
    expect(secondInsert.event.event_id).toBe(eventEnvelope.event_id);
  });
});
