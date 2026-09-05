import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "@/server/domain/state-machine";
import { correlateSignal } from "@/server/domain/correlation";
import { reconcilePayment } from "@/server/domain/money";
import { evaluateProposal, isContactWindowOpen, isOrdinaryChasingEligible } from "@/server/domain/policy";
import { createDemoWorld } from "@/server/db/fixture-seed";
import { resolveRelativeContactTime } from "@/server/domain/dates";

describe("case state machine", () => {
  it("allows the canonical approval path and rejects illegal jumps", () => {
    expect(canTransition("detected", "investigating")).toBe(true);
    expect(canTransition("awaiting_approval", "contacted")).toBe(true);
    expect(canTransition("detected", "recovered")).toBe(false);
    expect(() => assertTransition("recovered", "contacted")).toThrow("ILLEGAL_CASE_TRANSITION");
  });
});

describe("correlation and money", () => {
  it("prefers exact references and refuses ambiguous heuristic matches", () => {
    const world = createDemoWorld();
    const exact = correlateSignal(world.signals[0], world.obligations, world.customers);
    expect(exact.status).toBe("matched");
    if (exact.status === "matched") expect(exact.confidence).toBe(1);

    const ambiguous = correlateSignal({ ...world.signals[0], payload: { customerEmail: world.customers[0].email, amount: 1849900, currency: "INR" }, id: "heuristic" }, [...world.obligations, { ...world.obligations[0], id: "duplicate-obligation", orderRef: undefined, cartRef: undefined }], world.customers);
    expect(ambiguous.status).toBe("ambiguous");
  });

  it("caps partial collections and flags overpayment without inventing balance", () => {
    expect(reconcilePayment(10000, 0, 3500)).toEqual({ accepted: 3500, remaining: 6500, overpayment: 0, status: "partial" });
    expect(reconcilePayment(10000, 3500, 6500).status).toBe("paid");
    expect(reconcilePayment(10000, 0, 11000)).toEqual({ accepted: 10000, remaining: 0, overpayment: 1000, status: "overpayment" });
  });
});

describe("policy boundaries", () => {
  it("blocks discounts, disputes, promises and incident outreach", () => {
    const world = createDemoWorld();
    const aditi = world.cases[0];
    expect(evaluateProposal(world.policy, aditi, { channel: "email", type: "recovery_message", externalAction: true }).decision).toBe("approval_required");
    expect(evaluateProposal(world.policy, aditi, { channel: "email", type: "recovery_message", discountMinor: 100, externalAction: true }).decision).toBe("blocked");
    expect(evaluateProposal(world.policy, { ...aditi, blocker: "dispute" }, { channel: "email", type: "recovery_message", externalAction: true }).decision).toBe("blocked");
    expect(isOrdinaryChasingEligible({ ...aditi, pauseUntil: "2099-01-01T00:00:00.000Z" }, world.policy)).toBe(false);
  });

  it("enforces contact windows, spacing and attempt limits at the execution boundary", () => {
    const world = createDemoWorld();
    const aditi = world.cases[0];
    const inWindow = new Date("2026-09-05T05:00:00.000Z");
    const outsideWindow = new Date("2026-09-05T02:00:00.000Z");
    expect(isContactWindowOpen(world.policy, inWindow)).toBe(true);
    expect(isContactWindowOpen(world.policy, outsideWindow)).toBe(false);
    expect(evaluateProposal(world.policy, aditi, { channel: "email", type: "recovery_message", externalAction: true, now: outsideWindow }).rules).toContain("contact_window");
    expect(evaluateProposal(world.policy, aditi, { channel: "email", type: "recovery_message", externalAction: true, attemptCount: world.policy.maxAttempts, now: inWindow }).rules).toContain("max_attempts");
    expect(evaluateProposal(world.policy, aditi, { channel: "email", type: "recovery_message", externalAction: true, lastContactAt: "2026-09-05T04:30:00.000Z", now: inWindow }).rules).toContain("minimum_spacing");
  });

  it("resolves a relative Friday using the merchant timezone", () => {
    const world = createDemoWorld();
    expect(resolveRelativeContactTime("Friday", new Date("2026-09-05T02:00:00.000Z"), world.policy).toISOString()).toBe("2026-09-11T03:30:00.000Z");
    expect(evaluateProposal(world.policy, { ...world.cases[0], blocker: "opted_out" }, { channel: "email", type: "recovery_message", externalAction: true }).decision).toBe("blocked");
  });
});
