import type { Obligation, Signal } from "@/shared/types";

export type CorrelationResult =
  | { status: "matched"; obligationId: string; confidence: number; reason: string }
  | { status: "ambiguous"; candidates: string[]; confidence: number; reason: string }
  | { status: "unmatched"; candidates: string[]; confidence: number; reason: string };

function normalized(value?: string) {
  return value?.trim().toLowerCase().replace(/\s+/g, " ") || "";
}

function exactReferences(signal: Signal, obligation: Obligation) {
  const payload = signal.payload;
  return [obligation.orderRef, obligation.cartRef, obligation.invoiceRef].filter(Boolean).some((ref) => {
    return [payload.orderRef, payload.cartRef, payload.invoiceRef, payload.referenceId].some((candidate) => candidate === ref);
  });
}

export function correlateSignal(signal: Signal, obligations: Obligation[], customers: Array<{ id: string; email: string }>): CorrelationResult {
  const exact = obligations.filter((obligation) => exactReferences(signal, obligation));
  if (exact.length === 1) return { status: "matched", obligationId: exact[0].id, confidence: 1, reason: "Exact order, cart, invoice or link reference matched." };
  if (exact.length > 1) return { status: "ambiguous", candidates: exact.map((item) => item.id), confidence: 0.5, reason: "Conflicting exact references matched more than one obligation." };

  const email = normalized(String(signal.payload.customerEmail || signal.payload.email));
  const amount = Number(signal.payload.amount || 0);
  const currency = normalized(String(signal.payload.currency || ""));
  const occurredAt = new Date(signal.occurredAt).getTime();
  const heuristic = obligations.filter((obligation) => {
    if (currency && normalized(obligation.currency) !== currency) return false;
    if (amount && obligation.amountDue !== amount) return false;
    const customer = customers.find((item) => item.id === obligation.customerId);
    if (email && normalized(customer?.email) !== email) return false;
    if (obligation.dueAt) {
      const due = new Date(obligation.dueAt).getTime();
      if (Math.abs(due - occurredAt) > 1000 * 60 * 60 * 48) return false;
    }
    return true;
  });
  if (heuristic.length === 1) return { status: "matched", obligationId: heuristic[0].id, confidence: 0.92, reason: "Customer, currency, exact amount and a narrow time window matched." };
  if (heuristic.length > 1) return { status: "ambiguous", candidates: heuristic.map((item) => item.id), confidence: 0.54, reason: "More than one obligation shares the heuristic identity; merchant review is required." };
  return { status: "unmatched", candidates: [], confidence: 0, reason: "No exact or high-confidence heuristic obligation match." };
}
