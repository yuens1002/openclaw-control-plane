import { z } from "zod";
import { DomainSchema } from "./control-plane.js";
import { VendingEventPayloadSchema } from "./vending.js";

export const EventTypeSchema = z.enum([
  "user_instruction.received",
  "call.started",
  "location_lead.created",
  "call.completed",
  "call.transcribed",
  "call.processing_failed",
  "call.followup_due",
  "followup.due",
  "worker.run_requested",
  "approval.response_received",
  "briefing.requested",
  "schedule.tick"
]);
export type EventType = z.infer<typeof EventTypeSchema>;

const BaseEventEnvelopeSchema = z.object({
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
  idempotency_key: z.string().min(8)
});

export const LocationLeadCreatedEventSchema = BaseEventEnvelopeSchema.extend({
  event_type: z.literal("location_lead.created"),
  domain: z.literal("vending"),
  payload: VendingEventPayloadSchema.shape.leadCreated
});

export const CallTranscribedEventSchema = BaseEventEnvelopeSchema.extend({
  event_type: z.literal("call.transcribed"),
  domain: z.literal("vending"),
  payload: VendingEventPayloadSchema.shape.callTranscribed
});

export const GenericEventEnvelopeSchema = BaseEventEnvelopeSchema.extend({
  event_type: z.enum([
    "user_instruction.received",
    "call.started",
    "call.completed",
    "call.processing_failed",
    "call.followup_due",
    "followup.due",
    "worker.run_requested",
    "approval.response_received",
    "briefing.requested",
    "schedule.tick"
  ]),
  payload: z.record(z.unknown()).default({})
});

export const EventEnvelopeSchema = z.discriminatedUnion("event_type", [
  LocationLeadCreatedEventSchema,
  CallTranscribedEventSchema,
  GenericEventEnvelopeSchema
]);

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;

export function parseEventEnvelope(candidateEvent: unknown): EventEnvelope {
  return EventEnvelopeSchema.parse(candidateEvent);
}
