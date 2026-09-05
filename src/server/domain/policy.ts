import type { Policy, ProposalPolicyResult, RecoveryCase } from "@/shared/types";

export interface ProposalInput {
  channel: "email" | "system";
  type: string;
  discountMinor?: number;
  externalAction?: boolean;
  /** Supplied by the repository at the last safe execution boundary. */
  attemptCount?: number;
  lastContactAt?: string;
  now?: Date;
}

interface LocalTime {
  hour: number;
  minute: number;
}

function localTimeAt(timezone: string, at: Date): LocalTime | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === "hour")?.value);
    const minute = Number(parts.find((part) => part.type === "minute")?.value);
    return Number.isInteger(hour) && Number.isInteger(minute) ? { hour, minute } : undefined;
  } catch {
    return undefined;
  }
}

export function isContactWindowOpen(policy: Policy, at = new Date()) {
  const local = localTimeAt(policy.timezone, at);
  if (!local) return false;
  if (policy.contactStartHour === 0 && policy.contactEndHour === 24) return true;
  const currentMinute = local.hour * 60 + local.minute;
  const startMinute = policy.contactStartHour * 60;
  const endMinute = policy.contactEndHour * 60;
  if (startMinute < endMinute) return currentMinute >= startMinute && currentMinute < endMinute;
  if (startMinute > endMinute) return currentMinute >= startMinute || currentMinute < endMinute;
  return false;
}

export function nextContactWindowStart(policy: Policy, notBefore = new Date()) {
  if (isContactWindowOpen(policy, notBefore)) return notBefore;
  const candidate = new Date(notBefore);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);
  for (let minute = 0; minute < 8 * 24 * 60; minute += 1) {
    if (isContactWindowOpen(policy, candidate)) return new Date(candidate);
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

export function evaluateProposal(policy: Policy, recoveryCase: RecoveryCase, input: ProposalInput): ProposalPolicyResult {
  const rules: string[] = [];
  if (input.channel === "email" && !policy.allowedChannels.includes("email")) {
    return { decision: "blocked", reason: "This channel is not enabled by the merchant policy.", rules: ["allowed_channels"] };
  }
  if (input.discountMinor && input.discountMinor > 0 && !policy.discountsAllowed) {
    return { decision: "blocked", reason: "Discounts are disabled by the active merchant policy.", rules: ["discounts_disabled"] };
  }
  if (["dispute", "inability_to_pay", "opted_out"].includes(recoveryCase.blocker) && input.type !== "escalation") {
    return { decision: "blocked", reason: "This blocker requires escalation before ordinary outreach.", rules: ["stop_on_dispute_or_inability"] };
  }
  if (recoveryCase.state === "recovered" || recoveryCase.state === "closed") {
    return { decision: "blocked", reason: "The case is already closed or recovered.", rules: ["paid_or_closed"] };
  }
  rules.push("merchant_scope_verified");
  if (policy.incidentSuppression && recoveryCase.incidentId) {
    return { decision: "blocked", reason: "Outreach is suppressed while the assigned incident is active.", rules: ["incident_suppression"] };
  }
  const now = input.now || new Date();
  if (recoveryCase.blocker === "promise_to_pay" && recoveryCase.pauseUntil && new Date(recoveryCase.pauseUntil).getTime() > now.getTime() && input.type !== "promise_schedule") {
    return { decision: "blocked", reason: "The customer has a future payment promise; recheck after the promised date.", rules: ["promise_to_pay"] };
  }
  if (input.externalAction && input.channel === "email") {
    if (input.attemptCount !== undefined && input.attemptCount >= policy.maxAttempts) {
      return { decision: "blocked", reason: `The maximum of ${policy.maxAttempts} contact attempts for this obligation has been reached.`, rules: ["max_attempts"] };
    }
    if (input.lastContactAt) {
      const lastContact = new Date(input.lastContactAt).getTime();
      if (!Number.isFinite(lastContact) || !Number.isFinite(now.getTime())) {
        return { decision: "blocked", reason: "Contact history could not be safely validated.", rules: ["invalid_contact_history"] };
      }
      const nextAllowed = lastContact + policy.minimumSpacingHours * 60 * 60 * 1000;
      if (now.getTime() < nextAllowed) {
        return { decision: "blocked", reason: `The minimum ${policy.minimumSpacingHours}-hour spacing between contact attempts has not elapsed.`, rules: ["minimum_spacing"] };
      }
    }
    // Repository calls include `now` at proposal creation and immediately
    // before execution. Omitting it keeps this pure helper convenient for
    // callers that only need structural policy evaluation.
    if (input.now) {
      const local = localTimeAt(policy.timezone, now);
      if (!local) return { decision: "blocked", reason: "The merchant contact timezone is invalid; no outreach can be sent safely.", rules: ["invalid_timezone"] };
      if (!isContactWindowOpen(policy, now)) {
        return { decision: "blocked", reason: `Contact is only permitted between ${String(policy.contactStartHour).padStart(2, "0")}:00 and ${String(policy.contactEndHour).padStart(2, "0")}:00 ${policy.timezone}.`, rules: ["contact_window"] };
      }
    }
  }
  if (policy.reviewFirst && input.externalAction) {
    rules.push("review_first");
    return { decision: "approval_required", reason: "External customer-facing actions require merchant approval.", rules };
  }
  return { decision: "allowed", reason: "The action is within the active policy.", rules };
}

export function isOrdinaryChasingEligible(recoveryCase: RecoveryCase, policy: Policy, now = new Date()) {
  if (["recovered", "closed", "escalated"].includes(recoveryCase.state)) return false;
  if (["dispute", "inability_to_pay", "opted_out"].includes(recoveryCase.blocker)) return false;
  if (recoveryCase.pauseUntil && new Date(recoveryCase.pauseUntil).getTime() > now.getTime()) return false;
  if (policy.incidentSuppression && recoveryCase.incidentId) return false;
  return true;
}
