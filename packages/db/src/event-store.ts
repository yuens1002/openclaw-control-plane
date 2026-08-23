import type { EventEnvelope } from "@openclaw-control-plane/contracts";
import type { Pool, PoolClient } from "pg";

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

interface StoredEventRow {
  event_id: string;
  event_type: string;
  occurred_at: Date;
  source: string;
  domain: string;
  actor: EventEnvelope["actor"];
  subject: EventEnvelope["subject"];
  sensitivity: EventEnvelope["sensitivity"];
  idempotency_key: string;
  payload: EventEnvelope["payload"];
}

const INGESTED_EVENT_TYPE = "runtime.ingested_event";
const INGESTED_EVENT_SCHEMA_REF = "runtime://schemas/ingested-event/v1";
const INTERNAL_PRINCIPAL = "principal://service/event-store";

export class PostgresEventStore implements EventStore {
  constructor(private readonly pool: Pool) {}

  async insertEventIfNew(eventEnvelope: EventEnvelope): Promise<EventInsertResult> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      // Serialize retries before allocating stream order. The database unique
      // constraint remains the final idempotency boundary.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        eventEnvelope.idempotency_key
      ]);

      const existing = await selectByIdempotencyKey(client, eventEnvelope.idempotency_key);
      if (existing) {
        await client.query("COMMIT");
        return { status: "duplicate", event: toEventEnvelope(existing) };
      }

      await ensureGenericMetadata(client, eventEnvelope.domain);
      await requireActiveRuntimeEventRegistration(client);

      const streamId = `domain:${eventEnvelope.domain}`;
      await client.query(
        `INSERT INTO record_streams (stream_id, next_record_sequence)
         VALUES ($1, 1)
         ON CONFLICT (stream_id) DO NOTHING`,
        [streamId]
      );
      const stream = await client.query<{ next_record_sequence: string }>(
        `SELECT next_record_sequence
           FROM record_streams
          WHERE stream_id = $1
          FOR UPDATE`,
        [streamId]
      );
      const recordSequence = stream.rows[0]?.next_record_sequence;
      if (!recordSequence) {
        throw new Error(`Runtime stream ${streamId} could not be allocated.`);
      }

      await client.query(
        `INSERT INTO runtime_records
           (record_id, stream_id, record_sequence, kind, type, schema_version,
            schema_ref, operation_type, command_context,
            authenticated_principal_ref, effective_actor, subject, payload,
            occurred_at)
         VALUES
           ($1, $2, $3, 'event', $4, 1, $5, NULL, $6::jsonb,
            $7, $8::jsonb, $9::jsonb, $10::jsonb, $11::timestamptz)`,
        [
          eventEnvelope.event_id,
          streamId,
          recordSequence,
          INGESTED_EVENT_TYPE,
          INGESTED_EVENT_SCHEMA_REF,
          JSON.stringify(internalCommandContext(eventEnvelope.idempotency_key)),
          INTERNAL_PRINCIPAL,
          JSON.stringify({ type: "service", id: "event-store" }),
          JSON.stringify({
            type: "runtime.external_subject",
            id: eventEnvelope.subject.id ?? eventEnvelope.event_id
          }),
          JSON.stringify({
            event_type: eventEnvelope.event_type,
            source: eventEnvelope.source,
            reported_actor: eventEnvelope.actor,
            reported_subject: eventEnvelope.subject,
            sensitivity: eventEnvelope.sensitivity,
            data: eventEnvelope.payload
          }),
          eventEnvelope.occurred_at
        ]
      );
      await client.query(
        `UPDATE record_streams
            SET next_record_sequence = next_record_sequence + 1,
                updated_at = now()
          WHERE stream_id = $1`,
        [streamId]
      );

      await client.query(
        `INSERT INTO events
           (event_id, idempotency_key, event_type, registered_type,
            schema_version, schema_ref, runtime_record_id, source, domain,
            actor, subject, sensitivity, occurred_at, payload)
         VALUES
           ($1, $2, $3, $4, 1, $5, $1, $6, $7, $8::jsonb, $9::jsonb,
            $10, $11::timestamptz, $12::jsonb)`,
        [
          eventEnvelope.event_id,
          eventEnvelope.idempotency_key,
          eventEnvelope.event_type,
          INGESTED_EVENT_TYPE,
          INGESTED_EVENT_SCHEMA_REF,
          eventEnvelope.source,
          eventEnvelope.domain,
          JSON.stringify(eventEnvelope.actor),
          JSON.stringify(eventEnvelope.subject),
          eventEnvelope.sensitivity,
          eventEnvelope.occurred_at,
          JSON.stringify(eventEnvelope.payload)
        ]
      );

      await client.query("COMMIT");
      return { status: "inserted", event: eventEnvelope };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getEventByIdempotencyKey(idempotencyKey: string): Promise<EventEnvelope | null> {
    const result = await this.pool.query<StoredEventRow>(eventSelectSql(), [idempotencyKey]);
    return result.rows[0] ? toEventEnvelope(result.rows[0]) : null;
  }
}

async function selectByIdempotencyKey(
  client: PoolClient,
  idempotencyKey: string
): Promise<StoredEventRow | null> {
  const result = await client.query<StoredEventRow>(eventSelectSql(), [idempotencyKey]);
  return result.rows[0] ?? null;
}

function eventSelectSql(): string {
  return `SELECT event_id, event_type, occurred_at, source, domain, actor,
                 subject, sensitivity, idempotency_key, payload
            FROM events
           WHERE idempotency_key = $1`;
}

async function ensureGenericMetadata(client: PoolClient, domain: string): Promise<void> {
  await client.query(
    `INSERT INTO domains (id, display_name)
     VALUES ($1, $1)
     ON CONFLICT (id) DO NOTHING`,
    [domain]
  );
}

async function requireActiveRuntimeEventRegistration(client: PoolClient): Promise<void> {
  const registration = await client.query<{ status: string; schema_ref: string }>(
    `SELECT status, schema_ref
     FROM type_registrations
     WHERE kind = 'event' AND type = $1 AND schema_version = 1`,
    [INGESTED_EVENT_TYPE]
  );
  const row = registration.rows[0];
  if (row?.status !== "active" || row.schema_ref !== INGESTED_EVENT_SCHEMA_REF) {
    throw new Error(`Active runtime registration ${INGESTED_EVENT_TYPE}:1 is required.`);
  }
}

function internalCommandContext(idempotencyKey: string) {
  return {
    authenticated_principal_ref: INTERNAL_PRINCIPAL,
    effective_actor: { type: "service", id: "event-store" },
    request_origin: "internal",
    authorization: {
      decision_id: `legacy-event:${idempotencyKey}`,
      action: "legacy.event.ingest",
      result: "allowed",
      policy_version: "compatibility-v1",
      reason_codes: ["compatibility.event_store"]
    }
  };
}

function toEventEnvelope(row: StoredEventRow): EventEnvelope {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at.toISOString(),
    source: row.source,
    domain: row.domain,
    actor: row.actor,
    subject: row.subject,
    sensitivity: row.sensitivity,
    idempotency_key: row.idempotency_key,
    payload: row.payload
  };
}
