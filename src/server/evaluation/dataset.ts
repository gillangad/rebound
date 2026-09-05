import type { BlockerCategory, Customer, DocumentRecord, Message, Obligation, RecoveryCase, Signal } from "@/shared/types";

export interface EvaluationFixtureCase {
  caseId: string;
  label: string;
  customer: Customer;
  obligation: Obligation;
  /** All candidates available to the independent correlation pass. */
  correlationObligations: Obligation[];
  recoveryCase: RecoveryCase;
  signal?: Signal;
  messages: Message[];
  documents: DocumentRecord[];
  /** Answer key only. It is never used to construct observable evidence. */
  expected: {
    blocker: BlockerCategory | "ambiguous" | "insufficient_evidence";
    intervention: string;
    document?: string;
    contactEligible: boolean;
    resolvable: boolean;
  };
}

type EvaluationObservationKind =
  | "failed_purchase"
  | "missing_document"
  | "no_response"
  | "dispute"
  | "opted_out"
  | "promise_to_pay"
  | "partial_payment"
  | "paid"
  | "incident"
  | "ambiguous_purchase"
  | "ambiguous_invoice"
  | "insufficient_purchase"
  | "insufficient_invoice";

interface EvaluationObservation {
  kind: EvaluationObservationKind;
  amount: number;
  state: RecoveryCase["state"];
  pauseUntil?: string;
  documentName?: string;
  incidentId?: string;
}

interface EvaluationExpected {
  blocker: BlockerCategory | "ambiguous" | "insufficient_evidence";
  intervention: string;
  document?: string;
  contactEligible: boolean;
  resolvable: boolean;
}

interface EvaluationDefinition {
  index: number;
  label: string;
  observation: EvaluationObservation;
  expected: EvaluationExpected;
}

const merchantId = "11111111-1111-4111-8111-111111111111";
const occurredAt = "2026-09-04T08:00:00.000Z";
const dueAt = "2026-09-04T08:00:00.000Z";

export function evaluationDocumentName(sequence: number) {
  return `eval-delivery-${sequence}.txt`;
}

function definition(index: number, label: string, observation: EvaluationObservation, expected: EvaluationExpected): EvaluationDefinition {
  return { index, label, observation, expected };
}

function isPurchaseObservation(kind: EvaluationObservationKind) {
  return ["failed_purchase", "ambiguous_purchase", "insufficient_purchase"].includes(kind);
}

function messageForObservation(observation: EvaluationObservation) {
  switch (observation.kind) {
    case "missing_document":
      return "Finance cannot release payment until the signed delivery confirmation is attached.";
    case "dispute":
      return "We dispute this invoice because the quantity received does not match the purchase order. Please review the discrepancy.";
    case "opted_out":
      return "Please opt out of future collection messages. Do not contact us again about this balance.";
    case "promise_to_pay":
      return "We will pay on Friday. Please do not follow up before then.";
    default:
      return undefined;
  }
}

function makeCase(input: EvaluationDefinition): EvaluationFixtureCase {
  const caseId = `eval-${String(input.index).padStart(3, "0")}`;
  const customer: Customer = {
    id: `${caseId}-customer`,
    type: "business",
    displayName: `Evaluation Customer ${String(input.index).padStart(2, "0")}`,
    email: `eval-${input.index}@example.test`,
    company: `Evaluation Customer ${String(input.index).padStart(2, "0")}`
  };
  const isPurchase = isPurchaseObservation(input.observation.kind);
  const reference = isPurchase ? `${caseId}-order` : `${caseId}-invoice`;
  const amountPaid = input.observation.kind === "paid"
    ? input.observation.amount
    : input.observation.kind === "partial_payment"
      ? Math.floor(input.observation.amount / 2)
      : 0;
  const obligation: Obligation = {
    id: `${caseId}-obligation`,
    customerId: customer.id,
    kind: isPurchase ? "purchase" : "invoice",
    amountDue: input.observation.amount,
    amountPaid,
    currency: "INR",
    orderRef: isPurchase ? reference : undefined,
    invoiceRef: isPurchase ? undefined : reference,
    status: amountPaid >= input.observation.amount ? "paid" : amountPaid > 0 ? "partially_paid" : "open",
    dueAt
  };
  const isAmbiguous = input.observation.kind === "ambiguous_purchase" || input.observation.kind === "ambiguous_invoice";
  const competitor: Obligation = {
    ...obligation,
    id: `${caseId}-competitor`,
    orderRef: isPurchase ? `${caseId}-competitor-order` : undefined,
    invoiceRef: isPurchase ? undefined : `${caseId}-competitor-invoice`
  };
  const correlationObligations = isAmbiguous ? [obligation, competitor] : [obligation];
  const recoveryCase: RecoveryCase = {
    id: caseId,
    merchantId,
    customerId: customer.id,
    obligationId: obligation.id,
    workflow: input.observation.kind === "incident" ? "shared_incident" : isPurchase ? "failed_purchase" : "invoice_resolution",
    state: input.observation.state,
    priority: "medium",
    // The fixture starts before diagnosis. The answer key below is not a seed diagnosis.
    blocker: "no_response",
    confidence: 0,
    reason: "Evidence review is pending",
    nextAction: "Run a bounded evidence review",
    pauseUntil: input.observation.pauseUntil,
    incidentId: input.observation.incidentId,
    version: 1,
    updatedAt: occurredAt,
    createdAt: occurredAt
  };
  const insufficient = input.observation.kind === "insufficient_purchase" || input.observation.kind === "insufficient_invoice";
  const signal: Signal | undefined = insufficient
    ? undefined
    : {
        id: `${caseId}-signal`,
        merchantId,
        type: input.observation.kind === "failed_purchase" ? "payment_failed" : input.observation.kind === "incident" ? "incident_pattern" : "email_received",
        source: input.observation.kind === "failed_purchase" || input.observation.kind === "incident" ? "razorpay" : "email",
        externalId: `${caseId}-external`,
        payload: {
          customerEmail: customer.email,
          amount: input.observation.amount,
          currency: "INR",
          ...(isAmbiguous ? {} : isPurchase ? { orderRef: obligation.orderRef } : { invoiceRef: obligation.invoiceRef })
        },
        occurredAt,
        correlationStatus: "pending_review"
      };
  const body = messageForObservation(input.observation);
  const messages: Message[] = body
    ? [{
        id: `${caseId}-message`,
        merchantId,
        caseId,
        obligationId: obligation.id,
        direction: "inbound",
        channel: "email",
        providerId: `${caseId}-email`,
        threadId: `${caseId}-thread`,
        subject: input.observation.kind === "missing_document" ? "Signed delivery confirmation" : "Re: payment follow-up",
        body,
        participants: [customer.email, "collections@fixture.example.test"],
        from: customer.email,
        to: ["collections@fixture.example.test"],
        providerMode: "fixture",
        providerUrl: `fixture://email/${caseId}`,
        receivedAt: occurredAt
      }]
    : [];
  const documents: DocumentRecord[] = input.observation.kind === "missing_document" && input.observation.documentName
    ? [{
        id: `${caseId}-document`,
        merchantId,
        customerId: customer.id,
        obligationId: obligation.id,
        providerId: `${caseId}-drive-document`,
        name: input.observation.documentName,
        mimeType: "text/plain",
        extractedText: `Signed delivery confirmation for ${obligation.invoiceRef}. Customer: ${customer.email}.`,
        sourceUrl: `fixture://drive/${input.observation.documentName}`,
        checksum: `${caseId}-document-checksum`,
        permission: "approved_customer_share",
        providerMode: "fixture",
        matchReason: "Customer and invoice references matched independently."
      }]
    : [];

  return {
    caseId,
    label: input.label,
    customer,
    obligation,
    correlationObligations,
    recoveryCase,
    signal,
    messages,
    documents,
    expected: input.expected
  };
}

const definitions: EvaluationDefinition[] = [
  ...Array.from({ length: 4 }, (_, offset) => {
    const index = offset + 1;
    return definition(index, "Failed purchase with exact order identity", { kind: "failed_purchase", amount: 1800000 + offset * 125000, state: "detected" }, { blocker: "payment_failed", intervention: "recovery_message", contactEligible: true, resolvable: true });
  }),
  ...Array.from({ length: 4 }, (_, offset) => {
    const index = offset + 5;
    const documentName = evaluationDocumentName(offset + 1);
    return definition(index, "Invoice waiting on a signed delivery document", { kind: "missing_document", amount: 4200000 + offset * 300000, state: "detected", documentName }, { blocker: "missing_document", intervention: "document_response", document: documentName, contactEligible: true, resolvable: true });
  }),
  ...Array.from({ length: 3 }, (_, offset) => definition(offset + 9, "No response and insufficient customer context", { kind: "no_response", amount: 2600000 + offset * 200000, state: "paused", pauseUntil: "2026-09-12T03:30:00.000Z" }, { blocker: "no_response", intervention: "no_action", contactEligible: false, resolvable: false })),
  ...Array.from({ length: 3 }, (_, offset) => definition(offset + 12, "Customer disputes invoice quantity", { kind: "dispute", amount: 5600000 + offset * 400000, state: "escalated" }, { blocker: "dispute", intervention: "escalation", contactEligible: false, resolvable: true })),
  ...Array.from({ length: 3 }, (_, offset) => definition(offset + 15, "Customer opted out of collection messages", { kind: "opted_out", amount: 3100000 + offset * 200000, state: "escalated" }, { blocker: "opted_out", intervention: "escalation", contactEligible: false, resolvable: true })),
  ...Array.from({ length: 3 }, (_, offset) => definition(offset + 18, "Promise-to-pay is not due yet", { kind: "promise_to_pay", amount: 4800000 + offset * 250000, state: "paused", pauseUntil: "2026-09-11T03:30:00.000Z" }, { blocker: "promise_to_pay", intervention: "promise_schedule", contactEligible: false, resolvable: true })),
  definition(21, "Partial payment leaves a balance", { kind: "partial_payment", amount: 8000000, state: "paused", pauseUntil: "2026-09-10T03:30:00.000Z" }, { blocker: "partial_payment", intervention: "no_action", contactEligible: false, resolvable: true }),
  definition(22, "Already-paid obligation", { kind: "paid", amount: 6400000, state: "recovered" }, { blocker: "partial_payment", intervention: "no_action", contactEligible: false, resolvable: true }),
  ...Array.from({ length: 3 }, (_, offset) => definition(offset + 23, "Active provider incident member", { kind: "incident", amount: [7200000, 5100000, 9300000][offset], state: "paused", incidentId: `eval-${String(offset + 23).padStart(3, "0")}-incident` }, { blocker: "incident", intervention: "suppressed", contactEligible: false, resolvable: true })),
  definition(26, "Ambiguous customer and amount match", { kind: "ambiguous_purchase", amount: 3900000, state: "escalated" }, { blocker: "ambiguous", intervention: "escalation", contactEligible: false, resolvable: false }),
  definition(27, "Ambiguous invoice candidates", { kind: "ambiguous_invoice", amount: 4500000, state: "escalated" }, { blocker: "ambiguous", intervention: "escalation", contactEligible: false, resolvable: false }),
  definition(28, "Insufficient evidence for a purchase", { kind: "insufficient_purchase", amount: 2700000, state: "paused" }, { blocker: "insufficient_evidence", intervention: "no_action", contactEligible: false, resolvable: false }),
  definition(29, "Insufficient evidence for an invoice", { kind: "insufficient_invoice", amount: 3300000, state: "paused" }, { blocker: "insufficient_evidence", intervention: "no_action", contactEligible: false, resolvable: false }),
  definition(30, "Dispute with an unresolved source document", { kind: "dispute", amount: 6800000, state: "escalated" }, { blocker: "dispute", intervention: "escalation", contactEligible: false, resolvable: true })
];

export const EVALUATION_DATASET_VERSION = "rebound-evaluation-2026-09-v1";
export const evaluationDataset = definitions.map(makeCase);
