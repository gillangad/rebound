import { createHash } from "node:crypto";
import { DEMO_CLOCK, DEMO_CURRENCY, DEMO_MERCHANT_ID, DEMO_TIME_ZONE } from "@/shared/constants";
import { capabilityStatus } from "@/server/config";
import type { DemoWorld } from "@/shared/types";

const now = DEMO_CLOCK;
const ago = (hours: number) => new Date(new Date(now).getTime() - hours * 60 * 60 * 1000).toISOString();

export function createDemoWorld(workspaceId = DEMO_MERCHANT_ID, capabilities = capabilityStatus()): DemoWorld {
  const merchantId = DEMO_MERCHANT_ID;
  const customers = [
    { id: "20000000-0000-4000-8000-000000000001", type: "individual" as const, displayName: "Aditi Mehra", email: "aditi.mehra@example.com" },
    { id: "20000000-0000-4000-8000-000000000002", type: "business" as const, displayName: "Atelier Works Pvt Ltd", email: "priya@atelierworks.example", company: "Atelier Works Pvt Ltd" },
    { id: "20000000-0000-4000-8000-000000000003", type: "business" as const, displayName: "Brightline Studio", email: "finance@brightlinestudio.example", company: "Brightline Studio" },
    { id: "20000000-0000-4000-8000-000000000004", type: "business" as const, displayName: "Lumen & Co", email: "accounts@lumen.example", company: "Lumen & Co" },
    { id: "20000000-0000-4000-8000-000000000005", type: "business" as const, displayName: "Tamarind Labs", email: "finance@tamarind.example", company: "Tamarind Labs" },
    { id: "20000000-0000-4000-8000-000000000006", type: "business" as const, displayName: "Solis Design", email: "ops@solis.example", company: "Solis Design" },
    { id: "20000000-0000-4000-8000-000000000007", type: "individual" as const, displayName: "Rhea Kapoor", email: "rhea.kapoor@example.com" },
    { id: "20000000-0000-4000-8000-000000000008", type: "business" as const, displayName: "Orbit Retail", email: "ops@orbitretail.example", company: "Orbit Retail" }
  ];

  const obligations = [
    { id: "30000000-0000-4000-8000-000000000001", customerId: customers[0].id, kind: "purchase" as const, amountDue: 1849900, amountPaid: 0, currency: DEMO_CURRENCY, orderRef: "order_NSO_1001", cartRef: "cart_ADITI_CHAIR", status: "open" as const, dueAt: ago(7) },
    { id: "30000000-0000-4000-8000-000000000002", customerId: customers[1].id, kind: "invoice" as const, amountDue: 48000000, amountPaid: 0, currency: DEMO_CURRENCY, orderRef: "NSO-PO-8831", invoiceRef: "NSO-INV-2048", status: "open" as const, dueAt: ago(48 * 24) },
    { id: "30000000-0000-4000-8000-000000000003", customerId: customers[2].id, kind: "invoice" as const, amountDue: 7200000, amountPaid: 0, currency: DEMO_CURRENCY, invoiceRef: "NSO-INV-2039", status: "open" as const, dueAt: "2026-09-11T04:30:00.000Z" },
    { id: "30000000-0000-4000-8000-000000000004", customerId: customers[3].id, kind: "purchase" as const, amountDue: 13200000, amountPaid: 0, currency: DEMO_CURRENCY, orderRef: "order_NSO_1014", status: "open" as const, dueAt: ago(4) },
    { id: "30000000-0000-4000-8000-000000000005", customerId: customers[4].id, kind: "purchase" as const, amountDue: 8600000, amountPaid: 0, currency: DEMO_CURRENCY, orderRef: "order_NSO_1015", status: "open" as const, dueAt: ago(4) },
    { id: "30000000-0000-4000-8000-000000000006", customerId: customers[5].id, kind: "purchase" as const, amountDue: 9600000, amountPaid: 0, currency: DEMO_CURRENCY, orderRef: "order_NSO_1016", status: "open" as const, dueAt: ago(4) },
    { id: "30000000-0000-4000-8000-000000000007", customerId: customers[6].id, kind: "purchase" as const, amountDue: 2480000, amountPaid: 2480000, currency: DEMO_CURRENCY, orderRef: "order_NSO_1008", status: "paid" as const, dueAt: ago(5) },
    { id: "30000000-0000-4000-8000-000000000008", customerId: customers[7].id, kind: "invoice" as const, amountDue: 9650000, amountPaid: 0, currency: DEMO_CURRENCY, invoiceRef: "NSO-INV-2017", status: "open" as const, dueAt: ago(72 * 24) }
  ];

  const cases = [
    { id: "40000000-0000-4000-8000-000000000001", merchantId, customerId: customers[0].id, obligationId: obligations[0].id, workflow: "failed_purchase" as const, state: "detected" as const, priority: "high" as const, blocker: "no_response" as const, confidence: 0, reason: "Evidence review is pending", nextAction: "Awaiting the merchant review instruction", version: 1, updatedAt: ago(1), createdAt: ago(7), primary: true },
    { id: "40000000-0000-4000-8000-000000000002", merchantId, customerId: customers[1].id, obligationId: obligations[1].id, workflow: "invoice_resolution" as const, state: "detected" as const, priority: "high" as const, blocker: "no_response" as const, confidence: 0, reason: "Evidence review is pending", nextAction: "Awaiting the merchant review instruction", version: 1, updatedAt: ago(2), createdAt: ago(48 * 24), primary: true },
    { id: "40000000-0000-4000-8000-000000000003", merchantId, customerId: customers[2].id, obligationId: obligations[2].id, workflow: "invoice_resolution" as const, state: "paused" as const, priority: "medium" as const, blocker: "promise_to_pay" as const, confidence: 0.97, reason: "Customer promised payment on Friday", nextAction: "Recheck after Friday; do not contact before then", pauseReason: "Customer promise-to-pay", pauseUntil: "2026-09-11T04:30:00.000Z", incidentId: "70000000-0000-4000-8000-000000000001", version: 2, updatedAt: ago(4), createdAt: ago(72), primary: true },
    { id: "40000000-0000-4000-8000-000000000004", merchantId, customerId: customers[3].id, obligationId: obligations[3].id, workflow: "shared_incident" as const, state: "paused" as const, priority: "high" as const, blocker: "incident" as const, confidence: 0.84, reason: "HDFC card authorization failures clustered", nextAction: "Revalidate after the simulated incident resolves", pauseReason: "Shared HDFC authorization incident", incidentId: "70000000-0000-4000-8000-000000000001", version: 2, updatedAt: ago(3), createdAt: ago(4), primary: false },
    { id: "40000000-0000-4000-8000-000000000005", merchantId, customerId: customers[4].id, obligationId: obligations[4].id, workflow: "shared_incident" as const, state: "paused" as const, priority: "high" as const, blocker: "incident" as const, confidence: 0.83, reason: "HDFC card authorization failures clustered", nextAction: "Revalidate after the simulated incident resolves", pauseReason: "Shared HDFC authorization incident", incidentId: "70000000-0000-4000-8000-000000000001", version: 2, updatedAt: ago(3), createdAt: ago(4), primary: false },
    { id: "40000000-0000-4000-8000-000000000006", merchantId, customerId: customers[5].id, obligationId: obligations[5].id, workflow: "shared_incident" as const, state: "paused" as const, priority: "medium" as const, blocker: "incident" as const, confidence: 0.82, reason: "HDFC card authorization failures clustered", nextAction: "Revalidate after the simulated incident resolves", pauseReason: "Shared HDFC authorization incident", incidentId: "70000000-0000-4000-8000-000000000001", version: 2, updatedAt: ago(3), createdAt: ago(4), primary: false },
    { id: "40000000-0000-4000-8000-000000000007", merchantId, customerId: customers[6].id, obligationId: obligations[6].id, workflow: "shared_incident" as const, state: "recovered" as const, priority: "low" as const, blocker: "payment_failed" as const, confidence: 1, reason: "Payment verified before incident review", nextAction: "No action — collection verified", incidentId: "70000000-0000-4000-8000-000000000001", version: 5, updatedAt: ago(5), createdAt: ago(26), primary: false },
    { id: "40000000-0000-4000-8000-000000000008", merchantId, customerId: customers[7].id, obligationId: obligations[7].id, workflow: "invoice_resolution" as const, state: "escalated" as const, priority: "high" as const, blocker: "dispute" as const, confidence: 0.96, reason: "Invoice disputed due to a quantity mismatch", nextAction: "Review dispute evidence; ordinary reminders stopped", pauseReason: "Customer dispute", incidentId: "70000000-0000-4000-8000-000000000001", version: 2, updatedAt: ago(18), createdAt: ago(72 * 24), primary: false }
  ];

  const signals = [
    { id: "50000000-0000-4000-8000-000000000001", merchantId, type: "payment_failed" as const, source: "razorpay" as const, externalId: "pay_failed_aditi_001", payload: { orderRef: "order_NSO_1001", cartRef: "cart_ADITI_CHAIR", customerEmail: "aditi.mehra@example.com", amount: 1849900, currency: DEMO_CURRENCY }, occurredAt: ago(7), correlationStatus: "pending_review" as const },
    { id: "50000000-0000-4000-8000-000000000002", merchantId, type: "checkout_abandoned" as const, source: "storefront" as const, externalId: "checkout_abandoned_aditi_001", payload: { orderRef: "order_NSO_1001", cartRef: "cart_ADITI_CHAIR", customerEmail: "aditi.mehra@example.com", amount: 1849900, currency: DEMO_CURRENCY }, occurredAt: ago(6.8), correlationStatus: "pending_review" as const },
    { id: "50000000-0000-4000-8000-000000000003", merchantId, type: "email_received" as const, source: "email" as const, externalId: "fixture-thread-atelier-1", payload: { invoiceRef: "NSO-INV-2048", orderRef: "NSO-PO-8831", customerEmail: "priya@atelierworks.example" }, occurredAt: ago(2), correlationStatus: "pending_review" as const },
    { id: "50000000-0000-4000-8000-000000000004", merchantId, type: "email_received" as const, source: "email" as const, externalId: "fixture-thread-brightline-1", payload: { invoiceRef: "NSO-INV-2039", customerEmail: "finance@brightlinestudio.example" }, occurredAt: ago(4), correlationStatus: "matched" as const, obligationId: obligations[2].id, caseId: cases[2].id },
    { id: "50000000-0000-4000-8000-000000000005", merchantId, type: "incident_pattern" as const, source: "system" as const, externalId: "fixture-incident-hdfc-20260905", payload: { method: "card", provider: "HDFC", instrument: "authorization", failureCount: 3, affectedValue: 31400000 }, occurredAt: ago(3.5), correlationStatus: "matched" as const, caseId: cases[3].id },
    { id: "50000000-0000-4000-8000-000000000006", merchantId, type: "payment_captured" as const, source: "razorpay" as const, externalId: "pay_rhea_verified_001", payload: { orderRef: "order_NSO_1008", amount: 2480000, currency: DEMO_CURRENCY }, occurredAt: ago(5), correlationStatus: "matched" as const, obligationId: obligations[6].id, caseId: cases[6].id },
    { id: "50000000-0000-4000-8000-000000000007", merchantId, type: "email_received" as const, source: "email" as const, externalId: "fixture-thread-dispute-1", payload: { invoiceRef: "NSO-INV-2017", customerEmail: "ops@orbitretail.example" }, occurredAt: ago(18), correlationStatus: "matched" as const, obligationId: obligations[7].id, caseId: cases[7].id }
  ];

  const paymentAttempts = [
    { id: "60000000-0000-4000-8000-000000000001", merchantId, obligationId: obligations[0].id, razorpayPaymentId: "pay_failed_aditi_001", amount: 1849900, method: "card", status: "failed" as const, errorCode: "BAD_REQUEST_ERROR", errorDescription: "Card declined by the issuing bank", errorSource: "bank", errorStep: "authorization", createdAt: ago(7) },
    { id: "60000000-0000-4000-8000-000000000002", merchantId, obligationId: obligations[3].id, razorpayPaymentId: "pay_hdfc_lumen_001", amount: 13200000, method: "card", status: "failed" as const, errorCode: "GATEWAY_ERROR", errorDescription: "Issuer authorization unavailable", errorSource: "gateway", errorStep: "authorization", createdAt: ago(4) },
    { id: "60000000-0000-4000-8000-000000000003", merchantId, obligationId: obligations[4].id, razorpayPaymentId: "pay_hdfc_tamarind_001", amount: 8600000, method: "card", status: "failed" as const, errorCode: "GATEWAY_ERROR", errorDescription: "Issuer authorization unavailable", errorSource: "gateway", errorStep: "authorization", createdAt: ago(4) },
    { id: "60000000-0000-4000-8000-000000000004", merchantId, obligationId: obligations[5].id, razorpayPaymentId: "pay_hdfc_solis_001", amount: 9600000, method: "card", status: "failed" as const, errorCode: "GATEWAY_ERROR", errorDescription: "Issuer authorization unavailable", errorSource: "gateway", errorStep: "authorization", createdAt: ago(4) }
  ];

  const incident = { id: "70000000-0000-4000-8000-000000000001", merchantId, source: "system" as const, method: "card", provider: "HDFC", instrument: "authorization", severity: "high" as const, confirmation: "simulated" as const, status: "active" as const, startedAt: ago(3.5), summary: "Six recorded cases share a narrow HDFC authorization-failure pattern. Razorpay downtime confirmation is unavailable in fixture mode.", evidence: [signals[4].id, paymentAttempts[1].id, paymentAttempts[2].id, paymentAttempts[3].id] };

  // These are deliberately not normalized into the initial merchant world.
  // The fixture adapter owns the simulated external provider corpus and an
  // investigation retrieves and validates the matching record into the world.
  const documents: DemoWorld["documents"] = [];

  const messages = [
    { id: "90000000-0000-4000-8000-000000000002", merchantId, caseId: cases[2].id, obligationId: obligations[2].id, direction: "inbound" as const, channel: "email" as const, providerId: "fixture-thread-brightline-1", threadId: "fixture-thread-brightline-1", subject: "Payment timing for INV-2039", body: "We have queued the ₹72,000 payment for Friday. Please do not follow up before then.", participants: ["finance@brightlinestudio.example", "collections@northstar.example"], from: "finance@brightlinestudio.example", to: ["collections@northstar.example"], providerMode: "fixture" as const, receivedAt: ago(4) },
    { id: "90000000-0000-4000-8000-000000000003", merchantId, caseId: cases[7].id, obligationId: obligations[7].id, direction: "inbound" as const, channel: "email" as const, providerId: "fixture-thread-dispute-1", threadId: "fixture-thread-dispute-1", subject: "Dispute: INV-2017 quantity mismatch", body: "We dispute the outstanding invoice because two desks were not on the delivery receipt. Please pause collection while we reconcile.", participants: ["ops@orbitretail.example", "collections@northstar.example"], from: "ops@orbitretail.example", to: ["collections@northstar.example"], providerMode: "fixture" as const, receivedAt: ago(18) }
  ];

  const paymentLinks = [{ id: "a0000000-0000-4000-8000-000000000001", merchantId, obligationId: obligations[6].id, razorpayLinkId: "plink_fixture_rhea_paid_001", referenceId: "order_NSO_1008", amount: 2480000, amountPaid: 2480000, status: "paid" as const, url: "https://rzp.io/i/fixture-rhea-paid", publicToken: "fixture-rhea-paid-token", acceptPartial: false, createdAt: ago(26) }];
  const payments = [{ id: "b0000000-0000-4000-8000-000000000001", merchantId, obligationId: obligations[6].id, paymentLinkId: paymentLinks[0].id, razorpayPaymentId: "pay_rhea_verified_001", amount: 2480000, verified: true, capturedAt: ago(5), provider: "fixture" as const, webhookEventId: "fixture-event-rhea-001", createdAt: ago(5) }];
  const invoices = [
    { id: "c0000000-0000-4000-8000-000000000001", merchantId, obligationId: obligations[1].id, invoiceNumber: "NSO-INV-2048", issueDate: "2026-07-12", dueDate: "2026-07-29" },
    { id: "c0000000-0000-4000-8000-000000000002", merchantId, obligationId: obligations[2].id, invoiceNumber: "NSO-INV-2039", issueDate: "2026-08-12", dueDate: "2026-08-29" },
    { id: "c0000000-0000-4000-8000-000000000003", merchantId, obligationId: obligations[7].id, invoiceNumber: "NSO-INV-2017", issueDate: "2026-06-12", dueDate: "2026-06-29" }
  ];

  const policy = { id: "d0000000-0000-4000-8000-000000000001", merchantId, version: 3, reviewFirst: true, allowedChannels: ["email" as const], contactStartHour: 9, contactEndHour: 18, timezone: DEMO_TIME_ZONE, maxAttempts: 2, minimumSpacingHours: 24, discountsAllowed: false, autoSendClasses: [], incidentSuppression: true, updatedAt: ago(12) };

  const proposals = [
    { id: "e0000000-0000-4000-8000-000000000003", merchantId, caseId: cases[7].id, obligationId: obligations[7].id, type: "escalation" as const, intendedOutcome: "Stop ordinary reminders and route the disputed invoice for reconciliation.", recipient: "Northstar Office finance", scope: "Orbit Retail · invoice NSO-INV-2017", channel: "system" as const, payload: { reason: "Quantity mismatch in delivery receipt", stopReminders: true }, evidenceIds: [messages[1].id, signals[6].id], uncertainty: "The quantity claim requires merchant-side reconciliation; no payment conclusion is inferred.", explanation: "Orbit Retail explicitly disputes two desk quantities. The correct action is escalation and suppression, not a reminder.", policy: { decision: "allowed" as const, reason: "Disputes are routed to review and ordinary reminders stop.", rules: ["stop_on_dispute_or_inability"] }, requiresApproval: false, status: "executed" as const, actionVersion: 1, createdAt: ago(18) }
  ];

  const approvals: never[] = [];

  const jobs = [
    { id: "11000000-0000-4000-8000-000000000004", merchantId, kind: "recheck_promise" as const, idempotencyKey: `case:${cases[2].id}:promise:2026-09-11`, status: "queued" as const, caseId: cases[2].id, runAfter: "2026-09-11T04:30:00.000Z", attempts: 0 },
    { id: "11000000-0000-4000-8000-000000000005", merchantId, kind: "send_email" as const, idempotencyKey: `incident:${incident.id}:outreach`, status: "cancelled" as const, caseId: cases[3].id, attempts: 0, lastError: "Suppressed while incident is active" },
    { id: "11000000-0000-4000-8000-000000000006", merchantId, kind: "send_email" as const, idempotencyKey: `obligation:${obligations[6].id}:reminder`, status: "completed" as const, caseId: cases[6].id, attempts: 1 }
  ];

  const ledger = [{ id: "12000000-0000-4000-8000-000000000001", merchantId, obligationId: obligations[6].id, paymentId: payments[0].id, amount: 2480000, currency: DEMO_CURRENCY, idempotencyKey: "ledger:pay_rhea_verified_001", verifiedAt: ago(5) }];

  const audit = [
    { id: "13000000-0000-4000-8000-000000000001", merchantId, actor: "connector" as const, eventType: "signal.received", entityType: "signal", entityId: signals[0].id, summary: "Razorpay payment failed for Aditi’s chair order.", after: { source: "razorpay", externalId: signals[0].externalId }, sourceIds: [signals[0].id], createdAt: ago(7) },
    { id: "13000000-0000-4000-8000-000000000002", merchantId, actor: "connector" as const, eventType: "signal.received", entityType: "signal", entityId: signals[1].id, summary: "Storefront checkout abandonment received for the same order.", after: { source: "storefront", externalId: signals[1].externalId }, sourceIds: [signals[1].id], createdAt: ago(6.8) },
    { id: "13000000-0000-4000-8000-000000000003", merchantId, actor: "system" as const, eventType: "obligation.correlated", entityType: "obligation", entityId: obligations[0].id, summary: "Two signals merged into one canonical chair purchase.", after: { confidence: 0.99, matchedOn: ["orderRef", "cartRef", "amount", "customer"] }, sourceIds: [signals[0].id, signals[1].id], createdAt: ago(6.7) },
    { id: "13000000-0000-4000-8000-000000000004", merchantId, actor: "agent" as const, eventType: "proposal.executed", entityType: "proposal", entityId: proposals[0].id, summary: "Orbit Retail’s disputed invoice is routed to merchant review; ordinary reminders are stopped.", after: { type: proposals[0].type, evidenceIds: proposals[0].evidenceIds }, sourceIds: proposals[0].evidenceIds, createdAt: ago(1) },
    { id: "13000000-0000-4000-8000-000000000005", merchantId, actor: "system" as const, eventType: "fixture.evidence.available", entityType: "provider_corpus", entityId: "fixture-thread-atelier-1", summary: "Demo evidence is available in the simulated Email and Drive providers; it has not been attached to the Atelier case yet.", after: { emailProvider: "fixture", documentProvider: "fixture", retrievalRequired: true }, sourceIds: [], createdAt: ago(2), demo: true },
    { id: "13000000-0000-4000-8000-000000000008", merchantId, actor: "connector" as const, eventType: "incident.detected", entityType: "incident", entityId: incident.id, summary: "Demo simulation: HDFC card authorization failures clustered.", after: { confirmation: incident.confirmation, affectedCases: 6, affectedValue: 48250000 }, sourceIds: [signals[4].id], createdAt: ago(3.5), demo: true },
    { id: "13000000-0000-4000-8000-000000000009", merchantId, actor: "system" as const, eventType: "outreach.suppressed", entityType: "incident", entityId: incident.id, summary: "Demo simulation: six incident cases paused or already escalated; no ordinary outreach sent.", after: { reason: "incident_suppression", affectedCases: 6 }, sourceIds: [incident.id], createdAt: ago(3.4), demo: true },
    { id: "13000000-0000-4000-8000-000000000010", merchantId, actor: "connector" as const, eventType: "payment.webhook.verified", entityType: "payment", entityId: payments[0].id, summary: "Demo simulation: Razorpay-equivalent captured event verified for Rhea Kapoor.", after: { paymentId: payments[0].razorpayPaymentId, verified: true }, sourceIds: [signals[5].id], createdAt: ago(5), demo: true },
    { id: "13000000-0000-4000-8000-000000000011", merchantId, actor: "system" as const, eventType: "ledger.posted", entityType: "ledger", entityId: ledger[0].id, summary: "Verified collection posted once; remaining balance is ₹0.", after: { amount: ledger[0].amount, idempotencyKey: ledger[0].idempotencyKey }, sourceIds: [payments[0].id], createdAt: ago(5), demo: true },
    { id: "13000000-0000-4000-8000-000000000012", merchantId, actor: "connector" as const, eventType: "promise_to_pay.recorded", entityType: "case", entityId: cases[2].id, summary: "Brightline promised payment Friday; follow-up paused until the promised date.", after: { pauseUntil: cases[2].pauseUntil }, sourceIds: [messages[0].id], createdAt: ago(4) },
    { id: "13000000-0000-4000-8000-000000000013", merchantId, actor: "system" as const, eventType: "case.escalated", entityType: "case", entityId: cases[7].id, summary: "Orbit Retail dispute escalated; ordinary reminders stopped.", after: { blocker: "dispute" }, sourceIds: [messages[1].id], createdAt: ago(18) }
  ];

  const agentRuns = [
    { id: "14000000-0000-4000-8000-000000000001", merchantId, caseId: cases[0].id, provider: "fixture" as const, model: "scripted-fixture-recovery-v1", status: "completed" as const, stepCount: 4, toolCallSummaries: ["read_case_summary", "read_payment_failure", "find_related_signals", "propose_recovery_message"], startedAt: ago(1.2), finishedAt: ago(1) }
  ];

  const connectors = [
    { id: "15000000-0000-4000-8000-000000000001", merchantId, type: "razorpay" as const, mode: "fixture" as const, status: "fixture" as const, scopes: ["Payment Links", "Signed webhooks", "Test payments"], lastSyncAt: ago(0.5) },
    { id: "15000000-0000-4000-8000-000000000002", merchantId, type: "email" as const, mode: "fixture" as const, status: "fixture" as const, scopes: ["Read threads", "Send approved email"], lastSyncAt: ago(2) },
    { id: "15000000-0000-4000-8000-000000000003", merchantId, type: "drive" as const, mode: "fixture" as const, status: "fixture" as const, scopes: ["Search metadata", "Read approved text"], lastSyncAt: ago(2) }
  ];

  const world: DemoWorld = { workspaceId, capabilities, merchant: { id: merchantId, name: "Northstar Office", mode: capabilities.agent.provider === "fixture" && capabilities.evidence.provider === "fixture" && capabilities.payment.provider === "fixture" ? "fixture" : "live", demo: true, workspaceId, agentProvider: capabilities.agent.provider as DemoWorld["merchant"]["agentProvider"], evidenceProvider: capabilities.evidence.provider as DemoWorld["merchant"]["evidenceProvider"], paymentProvider: capabilities.payment.provider as DemoWorld["merchant"]["paymentProvider"], storageProvider: capabilities.storage.provider as DemoWorld["merchant"]["storageProvider"], timezone: DEMO_TIME_ZONE, defaultCurrency: DEMO_CURRENCY }, customers, obligations, cases, signals, paymentAttempts, paymentLinks, payments, invoices, messages, documents, incidents: [incident], proposals, approvals, policy, jobs, ledger, audit, agentRuns, connectors, webhookReceipts: [], instructions: [], batchRuns: [] };
  return namespaceWorld(world, workspaceId);
}

function namespacedId(base: string, workspaceId: string) {
  if (workspaceId === DEMO_MERCHANT_ID) return base;
  const hex = createHash("sha256").update(`${workspaceId}:${base}`).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function namespaceWorld(world: DemoWorld, workspaceId: string) {
  if (workspaceId === DEMO_MERCHANT_ID) return world;
  const idMap = new Map<string, string>();
  const register = (value: string) => { if (!idMap.has(value)) idMap.set(value, namespacedId(value, workspaceId)); };
  register(world.merchant.id);
  register(world.policy.id);
  for (const collection of [world.customers, world.obligations, world.cases, world.signals, world.paymentAttempts, world.paymentLinks, world.payments, world.invoices, world.messages, world.documents, world.incidents, world.proposals, world.approvals, world.jobs, world.ledger, world.audit, world.agentRuns, world.connectors, world.webhookReceipts, world.instructions, world.batchRuns]) for (const item of collection) register(item.id);
  const remap = (value: unknown): unknown => {
    if (typeof value === "string") return idMap.get(value) || value;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object") { for (const [key, child] of Object.entries(value)) (value as Record<string, unknown>)[key] = remap(child); }
    return value;
  };
  remap(world);
  world.workspaceId = workspaceId;
  world.merchant.workspaceId = workspaceId;
  // Provider identifiers are external lookup keys too. Keep the seeded
  // fixture records isolated across anonymous workspaces so a webhook for one
  // browser can never resolve to another browser's simulated payment.
  const providerSuffix = createHash("sha256").update(`provider:${workspaceId}`).digest("hex").slice(0, 10);
  const providerMap = new Map<string, string>();
  for (const item of [...world.paymentAttempts, ...world.payments]) {
    if (item.razorpayPaymentId) providerMap.set(item.razorpayPaymentId, `${item.razorpayPaymentId}_${providerSuffix}`);
  }
  for (const item of world.paymentLinks) {
    if (item.razorpayLinkId) providerMap.set(item.razorpayLinkId, `${item.razorpayLinkId}_${providerSuffix}`);
  }
  const remapProviderReferences = (value: unknown): unknown => {
    if (typeof value === "string") {
      let result = value;
      for (const [from, to] of providerMap) result = result.replaceAll(from, to);
      return result;
    }
    if (Array.isArray(value)) return value.map(remapProviderReferences);
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) (value as Record<string, unknown>)[key] = remapProviderReferences(child);
    }
    return value;
  };
  remapProviderReferences(world);
  for (const link of world.paymentLinks) {
    const token = `${workspaceId}.${link.publicToken}`;
    link.publicToken = token;
    if (link.url.startsWith("/pay/")) link.url = `/pay/${token}`;
  }
  return world;
}

export function cloneDemoWorld(world: DemoWorld) {
  return structuredClone(world);
}
