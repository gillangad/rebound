import { tool } from "ai";
import { z } from "zod";
import type { AuditEvent, CaseView, Policy, Proposal, RecoveryCase } from "@/shared/types";
import { evaluateProposal } from "@/server/domain/policy";
import { proposalSchema } from "@/server/agent/schemas";

export interface RecoveryToolContext {
  readCaseSummary(caseId: string): Promise<CaseView>;
  readPaymentFailure(caseId: string): Promise<Record<string, unknown>>;
  findRelatedSignals(caseId: string): Promise<Array<Record<string, unknown>>>;
  searchCustomerMessages(caseId: string, query?: string): Promise<Array<Record<string, unknown>>>;
  searchCaseDocuments(caseId: string, query?: string): Promise<Array<Record<string, unknown>>>;
  readActivePolicies(caseId: string): Promise<Policy>;
  readIncidentContext(caseId: string): Promise<Record<string, unknown>>;
  createProposal(input: z.infer<typeof proposalSchema> & { type: Proposal["type"] }): Promise<Proposal>;
}

export interface RecoveryChatToolContext extends RecoveryToolContext {
  readWorkspaceSummary(): Promise<Record<string, unknown>>;
  readWorkspaceCases(): Promise<Array<Record<string, unknown>>>;
  readHistory(filter?: string): Promise<AuditEvent[]>;
  requestInvestigation(caseId: string): Promise<Record<string, unknown>>;
  pauseOutreach(caseId: string, reason: string, pauseUntil?: string): Promise<RecoveryCase>;
  resumeOutreach(caseId: string): Promise<RecoveryCase>;
  resolveContactTime(reference: string): Promise<string>;
}

export function recoveryTools(context: RecoveryToolContext) {
  return {
    read_case_summary: tool({
      description: "Read-only. Fetch the scoped customer, obligation, state, balance, blocker and next action for one recovery case.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.readCaseSummary(caseId)
    }),
    read_payment_failure: tool({
      description: "Read-only. Inspect normalized Razorpay failure fields and previous payment attempts. Never infer successful payment.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.readPaymentFailure(caseId)
    }),
    find_related_signals: tool({
      description: "Read-only. Find storefront, payment and incident signals linked to the case; ambiguous identity remains review-required.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.findRelatedSignals(caseId)
    }),
    search_customer_messages: tool({
      description: "Read-only. Search inbound/outbound Email evidence for this customer and obligation.",
      inputSchema: z.object({ caseId: z.string().min(1), query: z.string().max(200).optional() }),
      execute: async ({ caseId, query }) => context.searchCustomerMessages(caseId, query)
    }),
    search_case_documents: tool({
      description: "Read-only. Search Drive metadata and limited extracted text scoped to the customer and obligation. Do not expose another customer’s file.",
      inputSchema: z.object({ caseId: z.string().min(1), query: z.string().max(200).optional() }),
      execute: async ({ caseId, query }) => context.searchCaseDocuments(caseId, query)
    }),
    read_active_policies: tool({
      description: "Read-only. Read review-first, contact-window, spacing, attempt, channel, discount and incident suppression policy.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.readActivePolicies(caseId)
    }),
    read_incident_context: tool({
      description: "Read-only. Inspect provider incident confirmation, evidence, affected value and suppression status.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.readIncidentContext(caseId)
    }),
    propose_signal_merge: tool({
      description: "Proposal-producing only. Suggest joining signals into one obligation; deterministic validation still decides whether identity is safe.",
      inputSchema: proposalSchema,
      execute: async (input) => context.createProposal({ ...input, type: "signal_merge" })
    }),
    propose_recovery_message: tool({
      description: "Proposal-producing only. Draft one neutral Email and optional Standard Payment Link; it cannot send or mark payment successful.",
      inputSchema: proposalSchema,
      execute: async (input) => context.createProposal({ ...input, type: "recovery_message" })
    }),
    propose_document_response: tool({
      description: "Proposal-producing only. Draft an Email that references a correctly matched, permission-safe document.",
      inputSchema: proposalSchema.extend({ documentId: z.string().min(1) }),
      execute: async ({ documentId, ...input }) => context.createProposal({ ...input, type: "document_response", payload: { ...input.payload, documentId } })
    }),
    propose_pause_or_resume: tool({
      description: "Proposal-producing only. Suggest a pause or resume with a reason; policy and merchant controls remain authoritative.",
      inputSchema: proposalSchema.extend({ pauseUntil: z.string().datetime().optional() }),
      execute: async ({ pauseUntil, ...input }) => context.createProposal({ ...input, type: "pause_or_resume", payload: { ...input.payload, pauseUntil } })
    }),
    propose_promise_schedule: tool({
      description: "Proposal-producing only. Record a customer payment promise and recheck time; a promise is never payment authorization.",
      inputSchema: proposalSchema.extend({ promisedAt: z.string().datetime() }),
      execute: async ({ promisedAt, ...input }) => context.createProposal({ ...input, type: "promise_schedule", payload: { ...input.payload, promisedAt } })
    }),
    propose_escalation: tool({
      description: "Proposal-producing only. Route disputes, ambiguity or overpayment for merchant review and stop ordinary chasing.",
      inputSchema: proposalSchema,
      execute: async (input) => context.createProposal({ ...input, type: "escalation" })
    }),
    finish_investigation: tool({
      description: "Read-only completion marker. Summarize visible evidence and uncertainty without hidden reasoning or external side effects.",
      inputSchema: z.object({ caseId: z.string().min(1), summary: z.string().min(1).max(700), uncertainty: z.string().min(1).max(500) }),
      execute: async ({ caseId, summary, uncertainty }) => ({ caseId, summary, uncertainty, status: "complete" as const })
    })
  };
}

/**
 * The chat tool set is deliberately separate from the investigation tool set.
 * It exposes a compact workspace view and a few existing, policy-aware
 * operations, while never exposing the repository or provider clients.
 */
export function recoveryChatTools(context: RecoveryChatToolContext) {
  const scoped = recoveryTools(context);
  return {
    read_workspace_summary: tool({
      description: "Read-only. Summarize the current tenant workspace: outstanding value, open cases, approvals, incidents and paused work.",
      inputSchema: z.object({}),
      execute: async () => context.readWorkspaceSummary()
    }),
    read_workspace_cases: tool({
      description: "Read-only. List concise, tenant-scoped recovery cases with customer, state, blocker, priority, outstanding amount and next action.",
      inputSchema: z.object({}),
      execute: async () => context.readWorkspaceCases()
    }),
    read_case_summary: scoped.read_case_summary,
    read_payment_failure: scoped.read_payment_failure,
    find_related_signals: scoped.find_related_signals,
    search_customer_messages: scoped.search_customer_messages,
    search_case_documents: scoped.search_case_documents,
    read_active_policies: scoped.read_active_policies,
    read_incident_context: scoped.read_incident_context,
    read_history: tool({
      description: "Read-only. Inspect a concise, tenant-scoped audit history for recent changes and decisions.",
      inputSchema: z.object({ filter: z.string().max(200).optional() }),
      execute: async ({ filter }) => context.readHistory(filter)
    }),
    resolve_contact_time: tool({
      description: "Read-only. Resolve a merchant-local date phrase such as Friday into an ISO recheck time; it does not pause or contact anyone.",
      inputSchema: z.object({ reference: z.string().min(1).max(80) }),
      execute: async ({ reference }) => context.resolveContactTime(reference)
    }),
    investigate_case: tool({
      description: "Bounded operation. Queue evidence retrieval and investigation for exactly one scoped case. The deterministic worker owns state transitions, policy checks and any proposal; this tool cannot send or mark payment successful.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.requestInvestigation(caseId)
    }),
    pause_outreach: tool({
      description: "Bounded operation. Pause outreach for exactly one scoped case through the deterministic policy/state layer. No customer message is sent and no payment state changes.",
      inputSchema: z.object({ caseId: z.string().min(1), reason: z.string().min(1).max(300), pauseUntil: z.string().datetime().optional() }),
      execute: async ({ caseId, reason, pauseUntil }) => context.pauseOutreach(caseId, reason, pauseUntil)
    }),
    resume_outreach: tool({
      description: "Bounded operation. Resume exactly one scoped case through the deterministic state layer for an evidence recheck. No customer message is sent.",
      inputSchema: z.object({ caseId: z.string().min(1) }),
      execute: async ({ caseId }) => context.resumeOutreach(caseId)
    }),
    propose_recovery_message: scoped.propose_recovery_message,
    propose_document_response: scoped.propose_document_response,
    propose_pause_or_resume: scoped.propose_pause_or_resume,
    propose_promise_schedule: scoped.propose_promise_schedule,
    propose_escalation: scoped.propose_escalation
  };
}

export function proposalPolicyFor(policy: Policy, recoveryCase: RecoveryCase, channel: "email" | "system", type: string) {
  return evaluateProposal(policy, recoveryCase, { channel, type, externalAction: channel === "email" });
}
