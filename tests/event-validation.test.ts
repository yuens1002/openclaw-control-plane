import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { EventEnvelopeSchema, LocationLeadCreatedEventSchema } from "@openclaw-control-plane/contracts";

const leadCreatedFixture = JSON.parse(
  readFileSync(new URL("./fixtures/lead-created-event.json", import.meta.url), "utf8")
) as unknown;

describe("EventEnvelope validation", () => {
  it("accepts a valid vending lead event", () => {
    const parsedEvent = LocationLeadCreatedEventSchema.parse(leadCreatedFixture);

    expect(parsedEvent.event_type).toBe("location_lead.created");
    expect(parsedEvent.domain).toBe("vending");
    expect(parsedEvent.payload.lead.location_name).toBe("North Loop Studio");
  });

  it("rejects an event with an invalid vending payload", () => {
    const invalidEvent = {
      ...(leadCreatedFixture as Record<string, unknown>),
      payload: {
        lead: {
          ...(LocationLeadCreatedEventSchema.parse(leadCreatedFixture).payload.lead),
          email: "not-an-email"
        }
      }
    };

    const result = EventEnvelopeSchema.safeParse(invalidEvent);

    expect(result.success).toBe(false);
  });
});
