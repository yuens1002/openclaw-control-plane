import {
  VendingCallTranscriptSchema,
  VendingFollowUpDraftSchema,
  VendingLeadSchema,
  type VendingCallTranscript,
  type VendingFollowUpDraft,
  type VendingLead
} from "@openclaw-control-plane/contracts";

export interface VendingWorker {
  name: "vending";
  ingestLead(candidateLead: unknown): VendingLead;
  draftFollowUp(candidateTranscript: unknown): VendingFollowUpDraft;
}

export function createVendingWorker(): VendingWorker {
  return {
    name: "vending",
    ingestLead(candidateLead) {
      return VendingLeadSchema.parse(candidateLead);
    },
    draftFollowUp(candidateTranscript) {
      const transcript = VendingCallTranscriptSchema.parse(candidateTranscript);
      return buildFollowUpDraft(transcript);
    }
  };
}

function buildFollowUpDraft(transcript: VendingCallTranscript): VendingFollowUpDraft {
  return VendingFollowUpDraftSchema.parse({
    lead_id: transcript.lead_id,
    subject: "Following up on our vending conversation",
    body: `Thanks for the conversation. Based on the call notes, the next step is to confirm location needs and approval timing.\n\nCall record source: ${transcript.id}`,
    source_call_record_id: transcript.id,
    approval_required: true,
    created_at: new Date().toISOString()
  });
}
