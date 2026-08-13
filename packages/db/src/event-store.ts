import type { EventEnvelope } from "@openclaw-control-plane/contracts";

export type EventInsertResult =
  | { status: "inserted"; event: EventEnvelope }
  | { status: "duplicate"; event: EventEnvelope };

export interface EventStore {
  insertEventIfNew(eventEnvelope: EventEnvelope): Promise<EventInsertResult>;
  getEventByIdempotencyKey(idempotencyKey: string): Promise<EventEnvelope | null>;
}

export class InMemoryEventStore implements EventStore {
  private readonly eventsByIdempotencyKey = new Map<string, EventEnvelope>();

  async insertEventIfNew(eventEnvelope: EventEnvelope): Promise<EventInsertResult> {
    const existingEvent = this.eventsByIdempotencyKey.get(eventEnvelope.idempotency_key);

    if (existingEvent) {
      return { status: "duplicate", event: existingEvent };
    }

    this.eventsByIdempotencyKey.set(eventEnvelope.idempotency_key, eventEnvelope);
    return { status: "inserted", event: eventEnvelope };
  }

  async getEventByIdempotencyKey(idempotencyKey: string): Promise<EventEnvelope | null> {
    return this.eventsByIdempotencyKey.get(idempotencyKey) ?? null;
  }
}
