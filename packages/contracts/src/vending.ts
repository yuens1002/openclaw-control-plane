import { z } from "zod";

export const VendingLeadSourceSchema = z.enum(["manual", "fake_fixture"]);
export type VendingLeadSource = z.infer<typeof VendingLeadSourceSchema>;

export const VendingLeadSchema = z.object({
  id: z.string().uuid(),
  location_name: z.string().min(1),
  business_type: z.string().min(1).nullable(),
  address: z.string().min(1).nullable(),
  contact_name: z.string().min(1).nullable(),
  contact_role: z.string().min(1).nullable(),
  email: z.string().email().nullable(),
  phone: z.string().min(7).nullable(),
  source: VendingLeadSourceSchema,
  source_refs: z.array(z.string()).default([]),
  notes: z.string().default("")
});
export type VendingLead = z.infer<typeof VendingLeadSchema>;

export const VendingCallTranscriptSchema = z.object({
  id: z.string().uuid(),
  lead_id: z.string().uuid(),
  transcript: z.string().min(1),
  captured_at: z.string().datetime()
});
export type VendingCallTranscript = z.infer<typeof VendingCallTranscriptSchema>;

export const VendingFollowUpDraftSchema = z.object({
  lead_id: z.string().uuid(),
  subject: z.string().min(1),
  body: z.string().min(1),
  source_call_record_id: z.string().uuid(),
  approval_required: z.literal(true),
  created_at: z.string().datetime()
});
export type VendingFollowUpDraft = z.infer<typeof VendingFollowUpDraftSchema>;

export const VendingEventPayloadSchema = z.object({
  leadCreated: z.object({
    lead: VendingLeadSchema
  }),
  callTranscribed: z.object({
    transcript: VendingCallTranscriptSchema
  })
});
