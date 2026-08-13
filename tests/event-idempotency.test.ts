import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { InMemoryEventStore } from "@openclaw-control-plane/db";
import { parseEventEnvelope } from "@openclaw-control-plane/contracts";

const leadCreatedFixture = JSON.parse(
  readFileSync(new URL("./fixtures/lead-created-event.json", import.meta.url), "utf8")
) as unknown;

describe("event idempotency", () => {
  it("inserts an event once for a given idempotency key", async () => {
    const eventStore = new InMemoryEventStore();
    const eventEnvelope = parseEventEnvelope(leadCreatedFixture);

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
