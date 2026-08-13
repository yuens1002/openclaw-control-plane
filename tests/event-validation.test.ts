import { describe, expect, it } from "vitest";
import { EventEnvelopeSchema, EventTypeSchema } from "@openclaw-control-plane/contracts";

describe("EventEnvelope validation", () => {
  it("accepts a valid generic workflow event", () => {
    const parsedEvent = EventEnvelopeSchema.parse(validEventEnvelope());

    expect(parsedEvent.event_type).toBe("example.lead_created");
    expect(parsedEvent.domain).toBe("example-workflow");
    expect(parsedEvent.payload.subject).toBe("North Loop Studio");
  });

  it("rejects an event with an invalid envelope", () => {
    const invalidEvent = {
      ...validEventEnvelope(),
      idempotency_key: "short"
    };

    const result = EventEnvelopeSchema.safeParse(invalidEvent);

    expect(result.success).toBe(false);
  });

  it("rejects unsafe event type identifiers", () => {
    expect(EventTypeSchema.safeParse(" example.lead_created ").success).toBe(false);
    expect(EventTypeSchema.safeParse("example lead created").success).toBe(false);
    expect(EventTypeSchema.safeParse("example/lead_created").success).toBe(false);
  });
});

function validEventEnvelope() {
  return {
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
  };
}
