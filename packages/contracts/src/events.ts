import { z } from "zod";
import { DomainSchema } from "./control-plane.js";

export const EventTypeSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Event type must be a safe identifier.");
export type EventType = z.infer<typeof EventTypeSchema>;

export const EventEnvelopeSchema = z.object({
  event_id: z.string().uuid(),
  event_type: EventTypeSchema,
  occurred_at: z.string().datetime(),
  source: z.string().min(1),
  domain: DomainSchema,
  actor: z.object({
    type: z.enum(["user", "system", "worker", "connector", "external_contact"]),
    id: z.string().min(1)
  }),
  subject: z.object({
    type: z.string().min(1),
    id: z.string().min(1).nullable()
  }),
  sensitivity: z.enum(["public", "business", "private"]),
  idempotency_key: z.string().min(8),
  payload: z.record(z.unknown()).default({})
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function parseEventEnvelope(candidateEvent: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(candidateEvent);
}
