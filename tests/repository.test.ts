import { describe, expect, it } from "vitest";
import { MemoryRepository } from "@/server/db/repository";

const batchInstruction = "Review these cases independently, resolve what you can, and bring me anything that needs approval.";

async function runBatch(repo: MemoryRepository) {
  const result = await repo.submitInstruction(undefined, batchInstruction);
  expect(result.batchRun?.status).toBe("queued");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = (await repo.bootstrap()).batchRuns.find((item) => item.id === result.batchRun?.id);
    if (current?.status === "completed") return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Fixture batch did not complete within the focused test timeout.");
}

function caseByName(repo: MemoryRepository, name: string) {
  const recoveryCase = repo.world.cases.find((item) => repo.world.customers.find((customer) => customer.id === item.customerId)?.displayName === name);
  expect(recoveryCase).toBeDefined();
  return recoveryCase!;
}

describe("fixture recovery service", () => {
  it("answers bounded agent questions without creating a job or agent run", async () => {
    const repo = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const instructionCount = repo.world.instructions.length;
    const runCount = repo.world.agentRuns.length;

    const count = await repo.submitInstruction(undefined, "How many issues do we have?");
    const affected = await repo.submitInstruction(undefined, "Which customers are affected?");
    const blocker = await repo.submitInstruction(undefined, "What is blocking City Interiors?");
    const greeting = await repo.submitInstruction(undefined, "Hi");

    expect(count.message).toContain("open recovery issues");
    expect(affected.message).toContain("City Interiors");
    expect(blocker.message).toContain("External evidence not retrieved yet");
    expect(greeting.message).toContain("I’m Rebound");
    expect(repo.world.instructions).toHaveLength(instructionCount);
    expect(repo.world.agentRuns).toHaveLength(runCount);
  });

  it("starts with a clean City Interiors case and runs one approval to one verified ledger posting", async () => {
    const repo = new MemoryRepository();
    const initial = await repo.bootstrap();
    const atelier = initial.cases.find((item) => item.customer.displayName === "City Interiors")!;

    expect(initial.proposals.some((item) => item.caseId === atelier.id)).toBe(false);
    expect(initial.cases.find((item) => item.id === atelier.id)?.messages).toHaveLength(0);
    expect(initial.cases.find((item) => item.id === atelier.id)?.documents).toHaveLength(0);
    expect(initial.cases.find((item) => item.id === atelier.id)?.paymentLink).toBeUndefined();
    expect(initial.ledger.some((item) => item.obligationId === atelier.obligationId)).toBe(false);
    expect(initial.connectors.every((item) => !("encryptedTokenRef" in item))).toBe(true);

    await runBatch(repo);
    const investigated = await repo.bootstrap();
    const proposal = investigated.proposals.find((item) => item.caseId === atelier.id && item.status === "pending")!;
    expect(proposal.type).toBe("document_response");
    expect(proposal.payload.amountMinor).toBe(48000000);

    const approvalVersion = atelier.version + 3;
    const approval = await repo.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: approvalVersion });
    const replayedApproval = await repo.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: approvalVersion });
    expect(replayedApproval.deduplicated).toBe(true);
    expect(repo.world.messages.filter((item) => item.caseId === atelier.id && item.direction === "outbound")).toHaveLength(1);
    expect(approval.message?.body).toContain("Delivery confirmation:");
    expect(approval.message?.body).toContain("Payment route:");
    expect(approval.paymentLink?.amount).toBe(48000000);
    expect(approval.paymentLink?.url).toMatch(/^\/pay\//);

    const page = await repo.getCustomerPage(approval.paymentLink!.publicToken);
    expect(page?.demo).toBe(true);
    expect(page?.document?.name).toBe("NW-DELIVERY-ATELIER-30-DESKS.txt");
    expect(page?.document?.extractedText).toContain("NSO-INV-2048");
    expect(page?.message?.body).toContain("api/documents/");

    const first = await repo.verifyFixturePayment(approval.paymentLink!.publicToken);
    const second = await repo.verifyFixturePayment(approval.paymentLink!.publicToken);
    expect(first.verified).toBe(true);
    expect(first.status).toBe("paid");
    expect(second.deduplicated).toBe(true);
    const after = await repo.bootstrap();
    expect(after.cases.find((item) => item.id === atelier.id)?.state).toBe("recovered");
    expect(after.ledger.filter((entry) => entry.obligationId === atelier.obligationId)).toHaveLength(1);
    expect(after.jobs.filter((job) => job.caseId === atelier.id && ["queued", "running"].includes(job.status))).toHaveLength(0);
    expect(after.integrationProof).toMatchObject({ mode: "fixture", apiConfirmed: false, connectorRetrievedMessages: 0, connectorRetrievedDocuments: 0, providerSentEmails: 0, razorpayCreatedLinks: 0, signedRazorpayPayments: 0, verifiedCollectedAmount: 0 });
  });

  it("investigates Aditi and City Interiors independently with one bounded batch run", async () => {
    const repo = new MemoryRepository();
    const batch = await runBatch(repo);
    expect(batch.caseIds).toHaveLength(2);
    expect(new Set(batch.caseIds).size).toBe(2);
    expect(batch.completedCaseIds).toHaveLength(2);
    const after = await repo.bootstrap();
    for (const name of ["Aditi Mehra", "City Interiors"]) {
      const recoveryCase = after.cases.find((item) => item.customer.displayName === name)!;
      expect(after.proposals.filter((item) => item.caseId === recoveryCase.id && item.status === "pending")).toHaveLength(1);
      expect(recoveryCase.state).toBe("awaiting_approval");
    }
    expect(repo.world.instructions[0]?.intent).toBe("batch_review");
    expect(after.batchRuns[0]?.concurrency).toBe(2);
    expect(after.audit.some((item) => item.eventType === "batch.completed")).toBe(true);
    expect(after.audit.some((item) => item.eventType === "connector.document.rejected" && item.after?.providerId === "fixture-drive-nw-delivery-lumen")).toBe(true);
  });

  it("denies a cross-customer document even if an approved proposal is tampered with", async () => {
    const repo = new MemoryRepository();
    await runBatch(repo);
    const atelier = caseByName(repo, "City Interiors");
    const proposal = repo.world.proposals.find((item) => item.caseId === atelier.id && item.status === "pending")!;
    expect(repo.world.documents.some((item) => item.providerId === "fixture-drive-nw-delivery-lumen")).toBe(false);
    proposal.payload = { ...proposal.payload, documentId: "fixture-drive-nw-delivery-lumen" };
    await expect(repo.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: proposal.actionVersion })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(repo.world.proposals.find((item) => item.id === proposal.id)?.status).toBe("blocked");
    expect(repo.world.paymentLinks.some((item) => item.obligationId === atelier.obligationId)).toBe(false);
    expect(repo.world.messages.some((item) => item.caseId === atelier.id && item.direction === "outbound")).toBe(false);
  });

  it("revalidates an incident and excludes paid, promised and disputed members", async () => {
    const repo = new MemoryRepository();
    const incident = (await repo.bootstrap()).incidents[0];
    const result = await repo.resolveIncident(incident.id);
    expect(result.eligibleCaseIds).toHaveLength(3);
    expect(result.excludedCaseIds).toHaveLength(3);
    const world = await repo.bootstrap();
    expect(world.incidents[0].status).toBe("resolved");
    expect(world.cases.find((item) => item.customer.displayName === "Rhea Kapoor")?.state).toBe("recovered");
    expect(world.cases.find((item) => item.customer.displayName === "Brightline Studio")?.state).toBe("paused");
    expect(world.cases.find((item) => item.customer.displayName === "Orbit Retail")?.state).toBe("escalated");
  });

  it("detects a bounded recent failure cluster and pauses ordinary outreach", async () => {
    const repo = new MemoryRepository();
    const detected = await repo.detectIncidents();
    expect(detected).toHaveLength(1);
    expect(detected[0]).toMatchObject({ provider: "HDFC", method: "card", instrument: "authorization", confirmation: "simulated", status: "active" });
    expect(repo.world.cases.filter((item) => item.incidentId === detected[0].id)).toHaveLength(6);
    expect(repo.world.audit.some((item) => item.eventType === "incident.updated")).toBe(true);
    expect(repo.world.audit.filter((item) => item.eventType === "outreach.suppressed" && item.entityType === "case")).toHaveLength(0);
  });

  it("stops investigation and outreach for cancelled obligations", async () => {
    const repo = new MemoryRepository();
    const aditi = caseByName(repo, "Aditi Mehra");
    repo.world.obligations.find((item) => item.id === aditi.obligationId)!.status = "cancelled";
    const result = await repo.investigateCase(aditi.id);
    expect(result.proposal).toBeUndefined();
    expect(repo.world.proposals.some((item) => item.caseId === aditi.id)).toBe(false);
    expect(repo.world.audit.some((item) => item.eventType === "investigation.stopped" && item.entityId === aditi.id)).toBe(true);
  });

  it("records changed promise and dispute circumstances from scoped inbound evidence", async () => {
    const promiseRepo = new MemoryRepository();
    const brightline = caseByName(promiseRepo, "Brightline Studio");
    await promiseRepo.investigateCase(brightline.id);
    expect(promiseRepo.world.cases.find((item) => item.id === brightline.id)).toMatchObject({ state: "paused", blocker: "promise_to_pay", pauseUntil: "2026-09-11T03:30:00.000Z" });
    expect(promiseRepo.world.audit.some((item) => item.eventType === "promise_to_pay.recorded" && item.sourceIds.includes("90000000-0000-4000-8000-000000000002"))).toBe(true);

    const disputeRepo = new MemoryRepository();
    const orbit = caseByName(disputeRepo, "Orbit Retail");
    await disputeRepo.investigateCase(orbit.id);
    expect(disputeRepo.world.cases.find((item) => item.id === orbit.id)?.state).toBe("escalated");
    expect(disputeRepo.world.audit.some((item) => item.eventType === "changed_circumstance.detected" && item.entityId === orbit.id)).toBe(true);
  });

  it("rejects a stale approval without sending or mutating the case as approved", async () => {
    const repo = new MemoryRepository();
    await runBatch(repo);
    const aditi = caseByName(repo, "Aditi Mehra");
    const proposal = repo.world.proposals.find((item) => item.caseId === aditi.id && item.status === "pending")!;
    const originalVersion = aditi.version;
    await repo.pauseCase(aditi.id, "Merchant changed direction");
    await expect(repo.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: originalVersion })).rejects.toMatchObject({ code: "STALE_VERSION" });
    expect((await repo.bootstrap()).cases.find((item) => item.id === aditi.id)?.messages.filter((item) => item.direction === "outbound")).toHaveLength(0);
    expect(repo.world.proposals.find((item) => item.id === proposal.id)?.status).toBe("stale");
  });

  it("accepts only a captured or paid Razorpay event and ignores event and provider replays", async () => {
    const repo = new MemoryRepository();
    await runBatch(repo);
    const atelier = caseByName(repo, "City Interiors");
    const proposal = repo.world.proposals.find((item) => item.caseId === atelier.id && item.status === "pending")!;
    const approved = await repo.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: proposal.actionVersion });
    const link = approved.paymentLink!;
    const basePayload = (paymentId: string, status: string) => ({
      entity: "event",
      event: "payment.captured",
      payload: {
        payment: { entity: { id: paymentId, amount: link.amount, currency: "INR", status, payment_link_id: link.razorpayLinkId } },
        payment_link: { entity: { id: link.razorpayLinkId, status: "paid", reference_id: link.referenceId, currency: "INR" } }
      }
    });

    const before = (await repo.bootstrap()).ledger.length;
    const failed = await repo.ingestRazorpayEvent("evt_failed_001", basePayload("pay_failed_001", "failed"), JSON.stringify({ raw: "failed" }));
    const authorized = await repo.ingestRazorpayEvent("evt_authorized_001", { ...basePayload("pay_authorized_001", "authorized"), event: "payment.authorized" });
    expect(failed.payment).toBeUndefined();
    expect(authorized.payment).toBeUndefined();
    expect((await repo.bootstrap()).ledger.length).toBe(before);

    const first = await repo.ingestRazorpayEvent("evt_captured_001", basePayload("pay_captured_001", "captured"), JSON.stringify({ raw: "captured" }));
    const replay = await repo.ingestRazorpayEvent("evt_captured_001", basePayload("pay_captured_001", "captured"), JSON.stringify({ raw: "captured-replay" }));
    const providerReplay = await repo.ingestRazorpayEvent("evt_captured_002", basePayload("pay_captured_001", "captured"));
    expect(first.payment?.verified).toBe(true);
    expect(replay.duplicate).toBe(true);
    expect(providerReplay.duplicate).toBe(true);
    expect((await repo.bootstrap()).ledger.filter((entry) => entry.obligationId === atelier.obligationId)).toHaveLength(1);
    expect(repo.world.webhookReceipts.find((receipt) => receipt.eventId === "evt_captured_001")?.rawBody).toBe(JSON.stringify({ raw: "captured" }));
    expect(repo.world.webhookReceipts.filter((receipt) => receipt.status === "review")).toHaveLength(2);
  });

  it("keeps partial balances visible, caps overpayment and posts once per provider payment", async () => {
    const partialRepo = new MemoryRepository();
    await runBatch(partialRepo);
    const aditi = caseByName(partialRepo, "Aditi Mehra");
    const proposal = partialRepo.world.proposals.find((item) => item.caseId === aditi.id && item.status === "pending")!;
    const approved = await partialRepo.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: proposal.actionVersion });
    const partial = await partialRepo.verifyFixturePayment(approved.paymentLink!.publicToken, 500000);
    expect(partial.status).toBe("partial");
    expect(partial.remainingAmount).toBe(1349900);
    expect(partialRepo.world.obligations.find((item) => item.id === aditi.obligationId)?.status).toBe("partially_paid");
    const link = approved.paymentLink!;
    const completeEvent = await partialRepo.ingestRazorpayEvent("evt_partial_followup", {
      event: "payment_link.paid",
      payload: {
        payment: { entity: { id: "pay_fixture_followup", amount: 1349900, currency: "INR", status: "captured", payment_link_id: link.razorpayLinkId } },
        payment_link: { entity: { id: link.razorpayLinkId, status: "paid", reference_id: link.referenceId, currency: "INR" } }
      }
    });
    expect(completeEvent.payment?.status).toBe("paid");
    expect(partialRepo.world.ledger.filter((item) => item.obligationId === aditi.obligationId)).toHaveLength(2);

    const overpaymentRepo = new MemoryRepository();
    await runBatch(overpaymentRepo);
    const atelier = caseByName(overpaymentRepo, "City Interiors");
    const atelierProposal = overpaymentRepo.world.proposals.find((item) => item.caseId === atelier.id && item.status === "pending")!;
    const atelierApproval = await overpaymentRepo.decideProposal({ proposalId: atelierProposal.id, decision: "approve", expectedCaseVersion: atelierProposal.actionVersion });
    const overpayment = await overpaymentRepo.verifyFixturePayment(atelierApproval.paymentLink!.publicToken, atelierApproval.paymentLink!.amount + 100);
    expect(overpayment.status).toBe("overpayment");
    expect(overpayment.acceptedAmount).toBe(atelierApproval.paymentLink!.amount);
    expect(overpaymentRepo.world.obligations.find((item) => item.id === atelier.obligationId)?.status).toBe("review_required");
    expect(overpaymentRepo.world.cases.find((item) => item.id === atelier.id)?.state).toBe("escalated");
    expect(overpaymentRepo.world.ledger.filter((item) => item.obligationId === atelier.obligationId)).toHaveLength(1);
  });

  it("defers outside the contact window and blocks the attempt limit at execution", async () => {
    const outsideWindow = new MemoryRepository(undefined, () => new Date("2026-09-05T02:00:00.000Z"));
    await runBatch(outsideWindow);
    const atelier = caseByName(outsideWindow, "City Interiors");
    const proposal = outsideWindow.world.proposals.find((item) => item.caseId === atelier.id && item.status === "pending")!;
    const deferred = await outsideWindow.decideProposal({ proposalId: proposal.id, decision: "approve", expectedCaseVersion: proposal.actionVersion });
    expect(deferred.proposal.status).toBe("approved");
    expect(deferred.message).toBeUndefined();
    expect((await outsideWindow.bootstrap()).jobs.some((job) => job.proposalId === proposal.id && job.status === "queued" && job.runAfter)).toBe(true);

    const limitedRepo = new MemoryRepository();
    await runBatch(limitedRepo);
    const limitedAditi = caseByName(limitedRepo, "Aditi Mehra");
    const limitedProposal = limitedRepo.world.proposals.find((item) => item.caseId === limitedAditi.id && item.status === "pending")!;
    await limitedRepo.updatePolicy({ maxAttempts: 1 });
    limitedRepo.world.messages.push({ id: "contact-attempt", merchantId: limitedRepo.world.merchant.id, caseId: limitedAditi.id, obligationId: limitedAditi.obligationId, direction: "outbound", channel: "email", providerId: "fixture-outbox-existing", subject: "Previous contact", body: "Previous contact", participants: ["collections@northstar.example", "aditi.mehra@example.com"], to: ["aditi.mehra@example.com"], sentAt: "2026-09-04T05:00:00.000Z" });
    await expect(limitedRepo.decideProposal({ proposalId: limitedProposal.id, decision: "approve", expectedCaseVersion: limitedProposal.actionVersion })).rejects.toMatchObject({ code: "POLICY_BLOCKED" });
    expect(limitedRepo.world.proposals.find((item) => item.id === limitedProposal.id)?.status).toBe("blocked");
  });

  it("resolves Friday relative to the injected merchant clock and persists a recheck", async () => {
    const repo = new MemoryRepository(undefined, () => new Date("2026-09-05T02:00:00.000Z"));
    const aditi = caseByName(repo, "Aditi Mehra");
    const result = await repo.submitInstruction(aditi.id, "Do not contact before Friday");
    expect(result.case?.pauseUntil).toBe("2026-09-11T03:30:00.000Z");
    expect(repo.world.instructions[0]?.pauseUntil).toBe(result.case?.pauseUntil);
    expect(repo.world.jobs.some((job) => job.kind === "recheck_promise" && job.runAfter === result.case?.pauseUntil)).toBe(true);
  });

  it("skips a repeated investigation when the canonical evidence and policy hash is unchanged", async () => {
    const repo = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const atelier = caseByName(repo, "City Interiors");
    const first = await repo.investigateCase(atelier.id);
    const runsAfterFirst = repo.world.agentRuns.length;
    const second = await repo.investigateCase(atelier.id);
    expect(second).toMatchObject({ skipped: true });
    expect(second.runId).toBe(first.runId);
    expect(repo.world.agentRuns).toHaveLength(runsAfterFirst);
    expect(repo.world.audit.some((item) => item.eventType === "agent.invocation.skipped" && item.entityId === atelier.id)).toBe(true);
  });

  it("does not invoke the agent during idle reconciliation or incident polling", async () => {
    const repo = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const before = repo.world.agentRuns.map((run) => run.id);
    await repo.reconcileSignals();
    await repo.detectIncidents();
    expect(repo.world.agentRuns.map((run) => run.id)).toEqual(before);
    expect(repo.world.audit.some((item) => item.eventType === "agent.invocation.started")).toBe(false);
  });

  it("keeps two demo workspace contexts isolated", async () => {
    const first = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const second = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const firstCase = caseByName(first, "City Interiors");
    await first.investigateCase(firstCase.id);
    expect(second.world.proposals).toHaveLength(1);
    expect(second.world.documents).toHaveLength(0);
    expect(first.world.documents).toHaveLength(1);
    expect(first.world.documents[0].id).not.toBe(second.world.documents[0]?.id);
  });
});
