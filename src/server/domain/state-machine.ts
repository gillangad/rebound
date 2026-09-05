import type { CaseState } from "@/shared/types";

export const LEGAL_CASE_TRANSITIONS: Record<CaseState, CaseState[]> = {
  detected: ["investigating", "paused", "escalated", "closed"],
  investigating: ["proposed", "paused", "escalated", "closed"],
  proposed: ["awaiting_approval", "contacted", "paused", "escalated", "closed"],
  awaiting_approval: ["contacted", "paused", "escalated", "closed"],
  contacted: ["recovered", "paused", "escalated", "closed"],
  recovered: ["closed"],
  paused: ["investigating", "proposed", "contacted", "recovered", "escalated", "closed"],
  escalated: ["investigating", "paused", "closed"],
  closed: []
};

export function canTransition(from: CaseState, to: CaseState) {
  return LEGAL_CASE_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: CaseState, to: CaseState) {
  if (!canTransition(from, to)) {
    throw new Error(`ILLEGAL_CASE_TRANSITION:${from}->${to}`);
  }
}

export function transitionCase<T extends { state: CaseState; version: number }>(record: T, to: CaseState) {
  assertTransition(record.state, to);
  return { ...record, state: to, version: record.version + 1 };
}
