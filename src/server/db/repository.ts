import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import demoEmails from "../../../fixtures/demo-emails.json";
import demoDriveDocuments from "../../../fixtures/demo-drive-documents.json";
import { DEMO_CLOCK, PRODUCT_NAME } from "@/shared/constants";
import type {
  AuditEvent,
  AgentProvider,
  AgentInvocationReason,
  BatchRun,
  BootstrapPayload,
  CaseView,
  ConnectorAccount,
  CustomerPageData,
  DemoWorld,
  Incident,
  InstructionRecord,
  JobRecord,
  LedgerEntry,
  Message,
  Payment,
  PaymentLink,
  Policy,
  Proposal,
  RecoveryCase,
  WebhookReceipt
} from "@/shared/types";
import { formatMoney } from "@/shared/formatters";
import { evaluateProposal, isOrdinaryChasingEligible, nextContactWindowStart, type ProposalInput } from "@/server/domain/policy";
import { correlateSignal } from "@/server/domain/correlation";
import { resolveRelativeContactTime } from "@/server/domain/dates";
import { readEvaluationReport } from "@/server/evaluation/report";
import { isFullyPaid, reconcilePayment } from "@/server/domain/money";
import { transitionCase } from "@/server/domain/state-machine";
import { newId } from "@/server/domain/ids";
import { assertEvidenceProvider, assertPaymentCredentials, capabilityStatus, runtimeConfig } from "@/server/config";
import { createDemoWorld } from "@/server/db/fixture-seed";
import { replaceNormalizedWorld } from "@/server/db/relational-sync";
import { decryptToken, FixtureDriveAdapter, FixtureEmailAdapter, GoogleDriveAdapter, GoogleEmailAdapter, type DriveAdapter, type EmailAdapter } from "@/server/integrations/google";
import { getRazorpayAdapter } from "@/server/integrations/razorpay";
import type { AgentRun } from "@/shared/types";
import type { RecoveryChatToolContext, RecoveryToolContext } from "@/server/agent/tools";
import { runRecoveryAgent, runRecoveryChat, type AgentChatResult, type ChatInvocationInput } from "@/server/agent/agent";

export type RepositoryErrorCode =
  | "NOT_FOUND"
  | "STALE_VERSION"
  | "POLICY_BLOCKED"
  | "ILLEGAL_TRANSITION"
  | "INVALID_PAYMENT"
  | "LIVE_CREDENTIALS_REQUIRED"
  | "DATABASE_REQUIRED"
  | "WORKSPACE_REQUIRED"
  | "PROVIDER_MISMATCH"
  | "AGENT_PROVIDER_FAILED"
  | "ALREADY_DONE";

export class RepositoryError extends Error {
  code: RepositoryErrorCode;
  details?: Record<string, unknown>;

  constructor(code: RepositoryErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "RepositoryError";
    this.code = code;
    this.details = details;
  }
}

export interface DecideProposalInput {
  proposalId: string;
  decision: "approve" | "reject";
  editedPayload?: Record<string, unknown>;
  rationale?: string;
  expectedCaseVersion?: number;
}

export interface PaymentOutcome {
  paymentId: string;
  caseId: string;
  verified: boolean;
  deduplicated: boolean;
  acceptedAmount: number;
  remainingAmount: number;
  overpayment: number;
  status: "partial" | "paid" | "overpayment";
  demo: boolean;
}

export interface ProposalDecisionResult {
  proposal: Proposal;
  case: RecoveryCase;
  message?: Message;
  paymentLink?: PaymentLink;
  deduplicated?: boolean;
}

export interface RecoveryRepository {
  bootstrap(): Promise<BootstrapPayload>;
  getCaseView(caseId: string): Promise<CaseView | null>;
  getCustomerPage(publicToken: string): Promise<CustomerPageData | null>;
  decideProposal(input: DecideProposalInput): Promise<ProposalDecisionResult>;
  investigateCase(caseId: string, invocationReason?: AgentInvocationReason): Promise<{ runId: string; proposal?: Proposal; skipped?: boolean }>;
  pauseCase(caseId: string, reason: string, pauseUntil?: string): Promise<RecoveryCase>;
  resumeCase(caseId: string): Promise<RecoveryCase>;
  submitInstruction(caseId: string | undefined, instruction: string): Promise<{ case?: RecoveryCase; message: string; batchRun?: BatchRun; agent?: { runId: string; provider: AgentProvider; model: string; toolCallSummaries: string[]; status: "completed" | "deduplicated" } }>;
  resolveIncident(incidentId: string): Promise<{ incident: Incident; eligibleCaseIds: string[]; excludedCaseIds: string[] }>;
  updatePolicy(input: Partial<Pick<Policy, "reviewFirst" | "allowedChannels" | "contactStartHour" | "contactEndHour" | "timezone" | "maxAttempts" | "minimumSpacingHours" | "discountsAllowed" | "incidentSuppression">>): Promise<Policy>;
  verifyFixturePayment(publicToken: string, amount?: number): Promise<PaymentOutcome>;
  ingestRazorpayEvent(eventId: string, event: Record<string, unknown>, rawBody?: string): Promise<{ duplicate: boolean; payment?: PaymentOutcome }>;
  audit(filter?: string): Promise<AuditEvent[]>;
  jobs(): Promise<JobRecord[]>;
  markJob(idempotencyKey: string, status: JobRecord["status"], lastError?: string): Promise<void>;
  completeBatchCase(batchRunId: string, caseId: string, error?: string): Promise<void>;
  reconcileSignals(): Promise<void>;
  detectIncidents(): Promise<Incident[]>;
  syncCaseEvidence(caseId: string): Promise<void>;
  resetDemo(): Promise<void>;
}

export interface RepositoryOptions {
  workspaceId?: string;
  merchantId?: string;
  publicToken?: string;
  fixtureAsync?: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function integrationProof(world: DemoWorld): BootstrapPayload["integrationProof"] {
  const uniqueCount = (eventType: string, key: string, provider: string) => new Set(world.audit.filter((event) => event.eventType === eventType && event.demo !== true && event.provider === provider).map((event) => String(event.after?.[key] || event.entityId))).size;
  const capabilities = world.capabilities || capabilityStatus();
  const paymentVerifiedEvents = capabilities.payment.provider !== "fixture" ? world.audit.filter((event) => event.eventType === "payment.webhook.verified" && event.demo !== true && event.provider === capabilities.payment.provider) : [];
  const externallyConfirmed = capabilities.evidence.provider !== "fixture" || capabilities.payment.provider !== "fixture" || capabilities.agent.provider !== "fixture";
  const externallyConfirmedAmount = new Set(paymentVerifiedEvents.map((event) => String(event.after?.providerPaymentId || event.entityId)));
  return {
    mode: world.merchant.mode,
    capabilities,
    connectorRetrievedMessages: externallyConfirmed && capabilities.evidence.provider !== "fixture" ? uniqueCount("connector.message.retrieved", "providerId", capabilities.evidence.provider) : 0,
    connectorRetrievedDocuments: externallyConfirmed && capabilities.evidence.provider !== "fixture" ? uniqueCount("connector.document.retrieved", "providerId", capabilities.evidence.provider) : 0,
    providerSentEmails: externallyConfirmed && capabilities.evidence.provider !== "fixture" ? uniqueCount("email.sent", "providerId", capabilities.evidence.provider) : 0,
    razorpayCreatedLinks: externallyConfirmed && capabilities.payment.provider !== "fixture" ? uniqueCount("payment_link.created", "referenceId", capabilities.payment.provider) : 0,
    signedRazorpayPayments: externallyConfirmedAmount.size,
    verifiedCollectedAmount: externallyConfirmedAmount.size > 0 ? world.ledger.filter((entry) => world.payments.some((payment) => payment.id === entry.paymentId && payment.provider === "razorpay" && externallyConfirmedAmount.has(payment.razorpayPaymentId))).reduce((total, entry) => total + entry.amount, 0) : 0,
    apiConfirmed: externallyConfirmed && capabilities.payment.provider !== "fixture" && externallyConfirmedAmount.size > 0
  };
}

function policyNow(_world: DemoWorld, clock: () => Date) {
  return clock();
}

function contactPolicyInput(world: DemoWorld, recoveryCase: RecoveryCase, input: ProposalInput, clock: () => Date): ProposalInput {
  if (!input.externalAction || input.channel !== "email") return input;
  const outbound = world.messages
    .filter((message) => message.direction === "outbound" && (message.caseId === recoveryCase.id || message.obligationId === recoveryCase.obligationId))
    .map((message) => message.sentAt)
    .filter((sentAt): sentAt is string => sentAt !== undefined && Number.isFinite(new Date(sentAt).getTime()))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime());
  return { ...input, attemptCount: outbound.length, lastContactAt: outbound[0], now: policyNow(world, clock) };
}

function canDeferContact(result: { decision: string; rules: string[] }) {
  return result.decision === "blocked" && result.rules.some((rule) => rule === "contact_window" || rule === "minimum_spacing");
}

function summarizeCaseChange(record: RecoveryCase) {
  return { state: record.state, version: record.version, nextAction: record.nextAction, pauseReason: record.pauseReason, pauseUntil: record.pauseUntil };
}

function isGreeting(instruction: string) {
  return /^(hi|hello|hey|good morning|good afternoon|good evening)[!. ]*$/i.test(instruction.trim());
}

function outstandingFor(world: DemoWorld, recoveryCase: RecoveryCase) {
  const obligation = world.obligations.find((item) => item.id === recoveryCase.obligationId);
  return obligation ? Math.max(0, obligation.amountDue - obligation.amountPaid) : 0;
}

function customerFor(world: DemoWorld, recoveryCase: RecoveryCase) {
  return world.customers.find((item) => item.id === recoveryCase.customerId);
}

function isBatchReviewRequest(instruction: string) {
  const lower = instruction.toLowerCase();
  return lower.includes("review these cases") || lower.includes("resolve what you can") || lower.includes("bring me anything");
}

function instructionWrites(caseId: string | undefined, instruction: string) {
  void caseId;
  return !isGreeting(instruction);
}

function canonicalChatInputHash(world: DemoWorld, prompt: string, selectedCaseId: string | undefined) {
  const stable = {
    prompt: prompt.trim(),
    selectedCaseId,
    provider: world.merchant.agentProvider || runtimeConfig().agentProvider,
    policyVersion: world.policy.version,
    cases: world.cases.map((recoveryCase) => ({ id: recoveryCase.id, customerId: recoveryCase.customerId, obligationId: recoveryCase.obligationId, workflow: recoveryCase.workflow, state: recoveryCase.state, priority: recoveryCase.priority, blocker: recoveryCase.blocker, confidence: recoveryCase.confidence, nextAction: recoveryCase.nextAction, pauseUntil: recoveryCase.pauseUntil })).sort((left, right) => left.id.localeCompare(right.id)),
    obligations: world.obligations.map((obligation) => ({ id: obligation.id, amountDue: obligation.amountDue, amountPaid: obligation.amountPaid, status: obligation.status, currency: obligation.currency })).sort((left, right) => left.id.localeCompare(right.id)),
    evidence: { messages: world.messages.map((message) => ({ id: message.id, providerId: message.providerId, caseId: message.caseId, obligationId: message.obligationId, body: message.body })).sort((left, right) => left.id.localeCompare(right.id)), documents: world.documents.map((document) => ({ id: document.id, providerId: document.providerId, customerId: document.customerId, obligationId: document.obligationId, checksum: document.checksum })).sort((left, right) => left.id.localeCompare(right.id)) }
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function compactWorkspaceCase(world: DemoWorld, recoveryCase: RecoveryCase) {
  const customer = customerFor(world, recoveryCase);
  const obligation = world.obligations.find((item) => item.id === recoveryCase.obligationId);
  return {
    id: recoveryCase.id,
    customer: customer ? { id: customer.id, displayName: customer.displayName, type: customer.type } : undefined,
    workflow: recoveryCase.workflow,
    state: recoveryCase.state,
    priority: recoveryCase.priority,
    blocker: recoveryCase.blocker,
    confidence: recoveryCase.confidence,
    outstandingAmount: obligation ? Math.max(0, obligation.amountDue - obligation.amountPaid) : 0,
    currency: obligation?.currency,
    reason: recoveryCase.reason,
    nextAction: recoveryCase.nextAction,
    pauseUntil: recoveryCase.pauseUntil
  };
}

function workspaceChatSummary(world: DemoWorld) {
  const openCases = world.cases.filter((item) => item.state !== "closed" && outstandingFor(world, item) > 0);
  const customerNames = [...new Set(openCases.map((item) => customerFor(world, item)?.displayName).filter((name): name is string => Boolean(name)))];
  return {
    merchant: { id: world.merchant.id, name: world.merchant.name, timezone: world.merchant.timezone, defaultCurrency: world.merchant.defaultCurrency },
    openCaseCount: openCases.length,
    affectedCustomerCount: customerNames.length,
    affectedCustomers: customerNames,
    outstandingAmount: openCases.reduce((total, item) => total + outstandingFor(world, item), 0),
    pendingApprovalCount: world.proposals.filter((item) => item.status === "pending").length,
    activeIncidentCount: world.incidents.filter((item) => item.status === "active").length,
    pausedCaseCount: openCases.filter((item) => item.state === "paused").length,
    demo: world.merchant.mode === "fixture"
  };
}

type AgentChatResponse = {
  case?: RecoveryCase;
  message: string;
  agent: { runId: string; provider: AgentProvider; model: string; toolCallSummaries: string[]; status: "completed" | "deduplicated" };
};

function canonicalAgentInputHash(world: DemoWorld, recoveryCase: RecoveryCase, clock: () => Date) {
  const obligation = world.obligations.find((item) => item.id === recoveryCase.obligationId);
  const stable = {
    // Lifecycle fields mutated by the previous agent run are deliberately not
    // part of the input identity. A replay of the same evidence must skip the
    // provider even though the case has moved to awaiting approval.
    case: { id: recoveryCase.id, customerId: recoveryCase.customerId, obligationId: recoveryCase.obligationId, workflow: recoveryCase.workflow, incidentId: recoveryCase.incidentId, pauseUntil: recoveryCase.pauseUntil },
    obligation: obligation && { id: obligation.id, amountDue: obligation.amountDue, amountPaid: obligation.amountPaid, status: obligation.status, currency: obligation.currency, orderRef: obligation.orderRef, invoiceRef: obligation.invoiceRef },
    signals: world.signals.filter((item) => item.caseId === recoveryCase.id || item.obligationId === recoveryCase.obligationId).map((item) => ({ id: item.id, type: item.type, source: item.source, externalId: item.externalId, payload: item.payload, occurredAt: item.occurredAt, correlationStatus: item.correlationStatus })).sort((a, b) => a.id.localeCompare(b.id)),
    messages: world.messages.filter((item) => item.caseId === recoveryCase.id || item.obligationId === recoveryCase.obligationId).map((item) => ({ providerId: item.providerId, threadId: item.threadId, subject: item.subject, body: item.body, from: item.from, to: item.to, receivedAt: item.receivedAt, sentAt: item.sentAt })).sort((a, b) => a.providerId.localeCompare(b.providerId)),
    documents: world.documents.filter((item) => item.customerId === recoveryCase.customerId && item.obligationId === recoveryCase.obligationId).map((item) => ({ providerId: item.providerId, name: item.name, mimeType: item.mimeType, extractedText: item.extractedText, checksum: item.checksum, permission: item.permission })).sort((a, b) => a.providerId.localeCompare(b.providerId)),
    incident: recoveryCase.incidentId ? world.incidents.find((item) => item.id === recoveryCase.incidentId && item.status === "active") : undefined,
    circumstance: { promiseDue: recoveryCase.pauseUntil ? new Date(recoveryCase.pauseUntil).getTime() <= clock().getTime() : false },
    policy: { version: world.policy.version, reviewFirst: world.policy.reviewFirst, allowedChannels: world.policy.allowedChannels, maxAttempts: world.policy.maxAttempts, minimumSpacingHours: world.policy.minimumSpacingHours, incidentSuppression: world.policy.incidentSuppression },
    provider: world.merchant.agentProvider || runtimeConfig().agentProvider
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function makeCaseView(world: DemoWorld, recoveryCase: RecoveryCase): CaseView {
  const customer = world.customers.find((item) => item.id === recoveryCase.customerId);
  const obligation = world.obligations.find((item) => item.id === recoveryCase.obligationId);
  if (!customer || !obligation) throw new RepositoryError("NOT_FOUND", "Case references incomplete customer or obligation data.");
  return {
    ...recoveryCase,
    customer,
    obligation,
    signals: world.signals.filter((item) => item.caseId === recoveryCase.id || item.obligationId === obligation.id),
    paymentAttempt: world.paymentAttempts.find((item) => item.obligationId === obligation.id),
    paymentLink: world.paymentLinks.find((item) => item.obligationId === obligation.id && !["cancelled", "expired"].includes(item.status)),
    invoice: world.invoices.find((item) => item.obligationId === obligation.id),
    messages: world.messages.filter((item) => item.caseId === recoveryCase.id || item.obligationId === obligation.id).sort((a, b) => (b.receivedAt || b.sentAt || "").localeCompare(a.receivedAt || a.sentAt || "")),
    documents: world.documents.filter((item) => item.customerId === customer.id && item.obligationId === obligation.id),
    proposals: world.proposals.filter((item) => item.caseId === recoveryCase.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    latestAudit: world.audit.filter((item) => item.entityId === recoveryCase.id || item.entityId === obligation.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 10),
    incident: recoveryCase.incidentId ? world.incidents.find((item) => item.id === recoveryCase.incidentId) : undefined
  };
}

export class MemoryRepository implements RecoveryRepository {
  public world: DemoWorld;
  private readonly clock: () => Date;
  private readonly fixtureAsync: boolean;
  private readonly chatInFlight = new Map<string, Promise<AgentChatResponse>>();

  constructor(world = createDemoWorld(), clock?: () => Date, options: { fixtureAsync?: boolean } = {}) {
    const legacyWorld = world as unknown as Record<string, unknown>;
    this.world = { ...(legacyWorld as unknown as DemoWorld), capabilities: (legacyWorld.capabilities as BootstrapPayload["capabilities"] | undefined) || capabilityStatus(), webhookReceipts: (legacyWorld.webhookReceipts as WebhookReceipt[] | undefined) || [], instructions: (legacyWorld.instructions as InstructionRecord[] | undefined) || [], batchRuns: (legacyWorld.batchRuns as BatchRun[] | undefined) || [] };
    const capabilities = this.world.capabilities!;
    this.world.merchant.agentProvider ||= capabilities.agent.provider as DemoWorld["merchant"]["agentProvider"];
    this.world.merchant.evidenceProvider ||= capabilities.evidence.provider as DemoWorld["merchant"]["evidenceProvider"];
    this.world.merchant.paymentProvider ||= capabilities.payment.provider as DemoWorld["merchant"]["paymentProvider"];
    this.world.merchant.storageProvider ||= capabilities.storage.provider as DemoWorld["merchant"]["storageProvider"];
    this.clock = clock || (() => new Date(this.world.merchant.demo ? DEMO_CLOCK : Date.now()));
    this.fixtureAsync = options.fixtureAsync ?? true;
  }

  protected emailAdapter(): EmailAdapter {
    if (this.selectedEvidenceProvider() === "fixture") return new FixtureEmailAdapter(demoEmails);
    if (this.selectedEvidenceProvider() === "google") return new GoogleEmailAdapter(this.googleAccessToken());
    assertEvidenceProvider();
    throw new RepositoryError("LIVE_CREDENTIALS_REQUIRED", "The selected evidence provider is not available in this build.");
  }

  protected driveAdapter(): DriveAdapter {
    if (this.selectedEvidenceProvider() === "fixture") return new FixtureDriveAdapter(demoDriveDocuments);
    if (this.selectedEvidenceProvider() === "google") return new GoogleDriveAdapter(this.googleAccessToken());
    assertEvidenceProvider();
    throw new RepositoryError("LIVE_CREDENTIALS_REQUIRED", "The selected evidence provider is not available in this build.");
  }

  protected googleAccessToken() {
    const connected = this.world.connectors.find((item) => (item.type === "email" || item.type === "drive") && item.encryptedTokenRef);
    if (connected?.encryptedTokenRef) return decryptToken(connected.encryptedTokenRef);
    const config = assertEvidenceProvider();
    if (config.evidenceProvider === "google" && config.googleAccessToken) return config.googleAccessToken;
    throw new RepositoryError("LIVE_CREDENTIALS_REQUIRED", "Google evidence requires a server-side access token or an encrypted connected token.");
  }

  protected selectedAgentProvider() {
    return this.world.merchant.agentProvider || runtimeConfig().agentProvider;
  }

  protected selectedPaymentProvider() {
    return this.world.merchant.paymentProvider || runtimeConfig().paymentProvider;
  }

  protected isDemoEvidence() {
    return this.selectedEvidenceProvider() === "fixture";
  }

  protected selectedEvidenceProvider() {
    return this.world.merchant.evidenceProvider || runtimeConfig().evidenceProvider;
  }

  protected isDemoPayment() {
    return this.selectedPaymentProvider() === "fixture";
  }

  /*
   * Kept as a single adapter factory so mixed deployments do not infer a
   * provider from the unrelated agent or storage mode.
   */
  protected paymentAdapter() {
    if (this.selectedPaymentProvider() === "fixture") return getRazorpayAdapter();
    assertPaymentCredentials();
    return getRazorpayAdapter();
  }

  /* The old live connector path is intentionally not selected by APP_MODE. */
  protected legacyEmailAdapter(): EmailAdapter {
    const connector = this.world.connectors.find((item) => item.type === "email" && item.mode === "live");
    if (!connector?.encryptedTokenRef) throw new RepositoryError("LIVE_CREDENTIALS_REQUIRED", "Live investigation requires a connected Google Email token.");
    return new GoogleEmailAdapter(decryptToken(connector.encryptedTokenRef));
  }

  protected addAudit(input: Omit<AuditEvent, "id" | "createdAt" | "merchantId">) {
    this.world.audit.unshift({ ...input, id: newId("audit"), merchantId: this.world.merchant.id, createdAt: nowIso() });
  }

  protected finishAgentRun(run: AgentRun, recoveryCase: RecoveryCase, usage?: AgentRun["usage"]) {
    run.status = "completed";
    run.finishedAt = nowIso();
    run.usage = usage;
    recoveryCase.lastAgentInputHash = run.inputHash;
    recoveryCase.lastAgentRunId = run.id;
    this.addAudit({ actor: "agent", eventType: "agent.invocation.completed", entityType: "case", entityId: recoveryCase.id, summary: `${run.provider} recovery provider completed a bounded investigation.`, after: { runId: run.id, provider: run.provider, invocationReason: run.invocationReason, inputHash: run.inputHash, stepCount: run.stepCount, toolCallSummaries: run.toolCallSummaries, usage }, sourceIds: [], provider: run.provider, invocationReason: run.invocationReason, inputHash: run.inputHash, usage });
  }

  protected getCase(caseId: string) {
    const recoveryCase = this.world.cases.find((item) => item.id === caseId);
    if (!recoveryCase) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
    return recoveryCase;
  }

  protected getProposal(proposalId: string) {
    const proposal = this.world.proposals.find((item) => item.id === proposalId);
    if (!proposal) throw new RepositoryError("NOT_FOUND", "Proposal not found.");
    return proposal;
  }

  protected caseForPolicy(recoveryCase: RecoveryCase): RecoveryCase {
    return this.isIncidentResolved(recoveryCase.incidentId) ? { ...recoveryCase, incidentId: undefined } : recoveryCase;
  }

  protected correlatePendingSignals() {
    for (const signal of this.world.signals.filter((item) => item.correlationStatus === "pending_review")) {
      const result = correlateSignal(signal, this.world.obligations, this.world.customers);
      if (result.status === "matched") {
        const recoveryCase = this.world.cases.find((item) => item.obligationId === result.obligationId);
        signal.obligationId = result.obligationId;
        signal.caseId = recoveryCase?.id;
        signal.correlationStatus = "matched";
        this.addAudit({ actor: "system", eventType: "signal.correlated", entityType: "signal", entityId: signal.id, summary: "Signal correlated to one canonical obligation using deterministic identity rules.", after: { obligationId: result.obligationId, caseId: recoveryCase?.id, confidence: result.confidence, reason: result.reason }, sourceIds: [signal.id] });
      } else if (result.status === "ambiguous") {
        this.addAudit({ actor: "system", eventType: "signal.ambiguous", entityType: "signal", entityId: signal.id, summary: "Signal remains in review because deterministic correlation found competing obligations.", after: { candidates: result.candidates, confidence: result.confidence, reason: result.reason }, sourceIds: [signal.id] });
      }
    }
    const obligationIds = new Set(this.world.signals.filter((signal) => signal.obligationId).map((signal) => signal.obligationId));
    for (const obligationId of obligationIds) {
      const signals = this.world.signals.filter((signal) => signal.obligationId === obligationId && signal.caseId);
      if (signals.length > 1) for (const signal of signals) signal.correlationStatus = "merged";
      if (signals.length > 1) this.addAudit({ actor: "system", eventType: "signal.deduplicated", entityType: "obligation", entityId: obligationId!, summary: `Merged ${signals.length} source signals into one canonical obligation and action path.`, after: { signalIds: signals.map((signal) => signal.id), count: signals.length }, sourceIds: signals.map((signal) => signal.id) });
    }
  }

  protected async syncConnectorEvidence(recoveryCase: RecoveryCase) {
    const customer = this.world.customers.find((item) => item.id === recoveryCase.customerId);
    const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
    if (!customer || !obligation) throw new RepositoryError("NOT_FOUND", "Case evidence references an incomplete customer or obligation.");
    const refs = [obligation.invoiceRef, obligation.orderRef, obligation.cartRef].filter((value): value is string => Boolean(value));
    const textFor = (value: string) => value.toLowerCase();
    const emailAdapter = this.emailAdapter();
    const emailResults = new Map<string, Awaited<ReturnType<EmailAdapter["getMessage"]>>>();
    for (const query of [...refs, customer.email]) {
      for (const result of await emailAdapter.searchThreads(query)) emailResults.set(result.providerId, result);
    }
    for (const result of emailResults.values()) {
      const full = await emailAdapter.getMessage(result.providerId);
      const haystack = textFor(`${full.subject} ${full.body} ${full.from} ${full.to.join(" ")}`);
      const referenceMatch = refs.some((ref) => haystack.includes(textFor(ref)));
      const customerMatch = haystack.includes(textFor(customer.email));
      if (!referenceMatch || !customerMatch) {
        if (!this.world.audit.some((event) => event.eventType === "connector.message.rejected" && event.after?.providerId === full.providerId)) this.addAudit({ actor: "connector", eventType: "connector.message.rejected", entityType: "message", entityId: full.providerId, summary: "Retrieved email was not attached because customer and obligation identity did not both match.", after: { providerId: full.providerId, providerMode: full.providerMode, referenceMatch, customerMatch }, sourceIds: [], provider: this.selectedEvidenceProvider() });
        continue;
      }
      let message = this.world.messages.find((item) => item.providerId === full.providerId);
      if (message && ((message.caseId && message.caseId !== recoveryCase.id) || (message.obligationId && message.obligationId !== obligation.id))) {
        this.addAudit({ actor: "connector", eventType: "connector.message.rejected", entityType: "message", entityId: full.providerId, summary: "Retrieved email was already scoped to another case; it was not reassigned across obligations.", after: { providerId: full.providerId, existingCaseId: message.caseId, existingObligationId: message.obligationId, requestedCaseId: recoveryCase.id, requestedObligationId: obligation.id }, sourceIds: [message.id] });
        continue;
      }
      const previousMessage = message && JSON.stringify({ threadId: message.threadId, subject: message.subject, body: message.body, from: message.from, to: message.to, receivedAt: message.receivedAt });
      if (!message) {
        message = { id: newId("message"), merchantId: this.world.merchant.id, caseId: recoveryCase.id, obligationId: obligation.id, direction: "inbound", channel: "email", providerId: full.providerId, threadId: full.threadId, subject: full.subject, body: full.body, participants: [full.from, ...full.to].filter(Boolean), from: full.from, to: full.to, providerMode: full.providerMode, providerUrl: full.providerUrl, receivedAt: full.receivedAt };
        this.world.messages.unshift(message);
      } else {
        Object.assign(message, { caseId: message.caseId || recoveryCase.id, obligationId: message.obligationId || obligation.id, threadId: full.threadId, subject: full.subject, body: full.body, participants: [full.from, ...full.to].filter(Boolean), from: full.from, to: full.to, providerMode: full.providerMode, providerUrl: full.providerUrl, receivedAt: full.receivedAt });
      }
      const signal = this.world.signals.find((item) => item.externalId === full.threadId || item.externalId === full.providerId);
      if (signal) { signal.obligationId = obligation.id; signal.caseId = recoveryCase.id; signal.correlationStatus = "matched"; }
      const nextMessage = JSON.stringify({ threadId: message.threadId, subject: message.subject, body: message.body, from: message.from, to: message.to, receivedAt: message.receivedAt });
      if (!previousMessage || previousMessage !== nextMessage) this.addAudit({ actor: "connector", eventType: "connector.message.retrieved", entityType: "message", entityId: message.id, summary: `${full.providerMode === "fixture" ? "Fixture " : "Live "}email retrieved with decoded sender, recipient, thread and body provenance.`, after: { providerId: full.providerId, threadId: full.threadId, providerMode: full.providerMode, providerUrl: full.providerUrl, from: full.from, to: full.to, subject: full.subject, receivedAt: full.receivedAt }, sourceIds: [message.id], provider: this.selectedEvidenceProvider() });
    }

    const driveAdapter = this.driveAdapter();
    const candidateDocuments = new Map<string, Awaited<ReturnType<DriveAdapter["searchDocuments"]>>[number]>();
    for (const query of [...refs, "delivery"]) for (const result of await driveAdapter.searchDocuments(query)) candidateDocuments.set(result.providerId, result);
    for (const candidate of candidateDocuments.values()) {
      let document: Awaited<ReturnType<DriveAdapter["readDocument"]>>;
      try { document = await driveAdapter.readDocument(candidate.providerId); } catch (error) {
        if (!this.world.audit.some((event) => event.eventType === "connector.document.error" && event.entityId === candidate.providerId)) this.addAudit({ actor: "connector", eventType: "connector.document.error", entityType: "document", entityId: candidate.providerId, summary: "Drive metadata was found but readable content could not be retrieved.", after: { error: error instanceof Error ? error.message : "unknown", providerMode: candidate.providerMode }, sourceIds: [], provider: this.selectedEvidenceProvider() });
        continue;
      }
      const haystack = textFor(`${document.name} ${document.extractedText}`);
      const matchedRefs = refs.filter((ref) => haystack.includes(textFor(ref)));
      const customerMatch = haystack.includes(textFor(customer.displayName)) || Boolean(customer.company && haystack.includes(textFor(customer.company)));
      const correct = customerMatch && matchedRefs.length >= Math.min(2, refs.length || 1);
      const existing = this.world.documents.find((item) => item.providerId === document.providerId);
      if (existing && ((existing.customerId && existing.customerId !== customer.id) || (existing.obligationId && existing.obligationId !== obligation.id))) {
        if (!this.world.audit.some((event) => event.eventType === "connector.document.rejected" && event.after?.providerId === document.providerId && event.after?.requestedObligationId === obligation.id)) this.addAudit({ actor: "connector", eventType: "connector.document.rejected", entityType: "document", entityId: existing.id, summary: "Retrieved document was already scoped to another customer or obligation; it was not reassigned.", after: { providerId: document.providerId, existingCustomerId: existing.customerId, existingObligationId: existing.obligationId, requestedCustomerId: customer.id, requestedObligationId: obligation.id }, sourceIds: [existing.id], provider: this.selectedEvidenceProvider() });
        continue;
      }
      if (!correct) {
        if (!this.world.audit.some((event) => event.eventType === "connector.document.rejected" && event.after?.providerId === document.providerId && event.after?.requestedObligationId === obligation.id)) this.addAudit({ actor: "connector", eventType: "connector.document.rejected", entityType: "document", entityId: existing?.id || document.providerId, summary: "Drive candidate rejected; customer and invoice/order identity did not match this case.", after: { providerId: document.providerId, name: document.name, customerMatch, matchedRefs, permission: existing?.permission || "merchant_only", providerMode: document.providerMode, requestedCustomerId: customer.id, requestedObligationId: obligation.id }, sourceIds: existing ? [existing.id] : [], provider: this.selectedEvidenceProvider() });
        continue;
      }
      const checksum = `sha256:${createHash("sha256").update(document.extractedText).digest("hex")}`;
      const record = existing || { id: newId("document"), merchantId: this.world.merchant.id, providerId: document.providerId, name: document.name, mimeType: document.mimeType, extractedText: document.extractedText, sourceUrl: document.sourceUrl, checksum, permission: "approved_customer_share" as const };
      Object.assign(record, { customerId: customer.id, obligationId: obligation.id, name: document.name, mimeType: document.mimeType, extractedText: document.extractedText, sourceUrl: document.sourceUrl, checksum, permission: "approved_customer_share" as const, providerMode: document.providerMode, matchReason: `Customer ${customer.displayName}, ${matchedRefs.join(" and ")} and readable delivery content match.` });
      if (!existing) this.world.documents.unshift(record);
      if (!existing || existing.checksum !== checksum) this.addAudit({ actor: "connector", eventType: "connector.document.retrieved", entityType: "document", entityId: record.id, summary: `${document.providerMode === "fixture" ? "Fixture " : "Live "}Drive document retrieved and permission-checked for this obligation.`, after: { providerId: document.providerId, name: document.name, mimeType: document.mimeType, providerMode: document.providerMode, sourceUrl: document.sourceUrl, matchedRefs, customerMatch, permission: record.permission }, sourceIds: [record.id], provider: this.selectedEvidenceProvider() });
    }
  }

  async bootstrap(): Promise<BootstrapPayload> {
    const outstanding = this.world.obligations.reduce((total, item) => total + Math.max(0, item.amountDue - item.amountPaid), 0);
    const verifiedRecovered = this.world.ledger.reduce((total, item) => total + item.amount, 0);
    const capabilities = this.world.capabilities || capabilityStatus();
    const connectors = this.world.connectors.map((connector) => {
      const capability = connector.type === "razorpay" ? capabilities.payment : capabilities.evidence;
      return { id: connector.id, merchantId: connector.merchantId, type: connector.type, mode: capability.provider as ConnectorAccount["mode"], status: capability.status === "ready" ? "healthy" as const : capability.status === "fixture" ? "fixture" as const : capability.status === "unsupported" ? "error" as const : "not_configured" as const, scopes: connector.scopes, lastSyncAt: connector.lastSyncAt };
    });
    const activeCase = this.world.cases.find((item) => item.primary && item.state !== "closed") || this.world.cases[0];
    let orb: BootstrapPayload["orb"] = { state: "idle", label: "Agent idle", updatedAt: nowIso() };
    const latestChatRun = this.world.agentRuns.find((run) => run.invocationReason === "explicit_chat");
    const activeInvestigationJob = this.world.jobs.find((job) => job.kind === "investigate_case" && ["queued", "running"].includes(job.status));
    if (latestChatRun?.status === "running") orb = { state: "working", label: "Agent is thinking", caseId: latestChatRun.caseId, updatedAt: latestChatRun.startedAt };
    else if (latestChatRun?.status === "failed") orb = { state: "error", label: "Provider needs attention", caseId: latestChatRun.caseId, updatedAt: latestChatRun.finishedAt || nowIso() };
    else if (activeInvestigationJob?.status === "queued") orb = { state: "inspecting", label: "Investigation queued", caseId: activeInvestigationJob.caseId, updatedAt: nowIso() };
    else if (activeInvestigationJob?.status === "running") orb = { state: "working", label: "Retrieving evidence", caseId: activeInvestigationJob.caseId, updatedAt: nowIso() };
    else if (activeCase?.state === "awaiting_approval") orb = { state: "approval", label: "Approval required", caseId: activeCase.id, updatedAt: activeCase.updatedAt };
    else if (activeCase?.state === "paused") orb = { state: "paused", label: "Outreach paused", caseId: activeCase.id, updatedAt: activeCase.updatedAt };
    else if (activeCase?.state === "recovered") orb = { state: "success", label: "Payment verified", caseId: activeCase.id, updatedAt: activeCase.updatedAt };

    return {
      productName: PRODUCT_NAME,
      merchant: this.world.merchant,
      mode: this.world.merchant.mode,
      summary: { outstanding, verifiedRecovered, currency: this.world.merchant.defaultCurrency },
      cases: this.world.cases.map((item) => makeCaseView(this.world, item)),
      incidents: this.world.incidents,
      proposals: this.world.proposals,
      approvals: this.world.approvals,
      policy: this.world.policy,
      connectors,
      audit: this.world.audit.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      ledger: this.world.ledger,
      jobs: this.world.jobs,
      orb,
      batchRuns: this.world.batchRuns,
      evaluation: await readEvaluationReport(),
      integrationProof: integrationProof(this.world),
      capabilities
    };
  }

  async getCaseView(caseId: string) {
    const recoveryCase = this.world.cases.find((item) => item.id === caseId);
    return recoveryCase ? makeCaseView(this.world, recoveryCase) : null;
  }

  protected chatToolContext(modelRunId: string): RecoveryChatToolContext {
    const scopedView = async (caseId: string) => {
      const view = await this.getCaseView(caseId);
      if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found in this merchant workspace.");
      return view;
    };
    return {
      readWorkspaceSummary: async () => workspaceChatSummary(this.world),
      readWorkspaceCases: async () => this.world.cases.map((recoveryCase) => compactWorkspaceCase(this.world, recoveryCase)),
      readHistory: async (filter) => {
        const normalized = filter?.trim().toLowerCase();
        return this.world.audit.filter((event) => !normalized || `${event.eventType} ${event.entityId} ${event.summary}`.toLowerCase().includes(normalized)).slice(0, 20);
      },
      readCaseSummary: scopedView,
      readPaymentFailure: async (caseId) => {
        const view = await scopedView(caseId);
        return view.paymentAttempt ? { id: view.paymentAttempt.id, providerPaymentId: view.paymentAttempt.razorpayPaymentId, amount: view.paymentAttempt.amount, status: view.paymentAttempt.status, errorCode: view.paymentAttempt.errorCode, errorDescription: view.paymentAttempt.errorDescription, errorSource: view.paymentAttempt.errorSource, errorStep: view.paymentAttempt.errorStep } : { status: "no_attempt_recorded" };
      },
      findRelatedSignals: async (caseId) => {
        const view = await scopedView(caseId);
        return view.signals.map((signal) => ({ id: signal.id, type: signal.type, source: signal.source, externalId: signal.externalId, payload: signal.payload, occurredAt: signal.occurredAt, correlationStatus: signal.correlationStatus }));
      },
      searchCustomerMessages: async (caseId, query) => {
        const view = await scopedView(caseId);
        const normalized = query?.trim().toLowerCase();
        return view.messages.filter((message) => !normalized || `${message.subject} ${message.body}`.toLowerCase().includes(normalized)).map((message) => ({ id: message.id, direction: message.direction, subject: message.subject, body: message.body.slice(0, 2000), participants: message.participants, receivedAt: message.receivedAt, sentAt: message.sentAt, providerMode: message.providerMode }));
      },
      searchCaseDocuments: async (caseId, query) => {
        const view = await scopedView(caseId);
        const normalized = query?.trim().toLowerCase();
        return view.documents.filter((document) => document.customerId === view.customer.id && document.obligationId === view.obligation.id && (!normalized || `${document.name} ${document.extractedText}`.toLowerCase().includes(normalized))).map((document) => ({ id: document.id, name: document.name, mimeType: document.mimeType, permission: document.permission, extractedText: document.extractedText.slice(0, 2500), checksum: document.checksum, providerMode: document.providerMode }));
      },
      readActivePolicies: async (caseId) => { await scopedView(caseId); return this.world.policy; },
      readIncidentContext: async (caseId) => {
        const view = await scopedView(caseId);
        return view.incident ? { id: view.incident.id, provider: view.incident.provider, method: view.incident.method, confirmation: view.incident.confirmation, status: view.incident.status, summary: view.incident.summary, evidence: view.incident.evidence } : { status: "no_incident" };
      },
      createProposal: (input) => this.createAgentProposal(input, modelRunId),
      requestInvestigation: async (caseId) => this.requestCaseInvestigation(caseId),
      pauseOutreach: async (caseId, reason, pauseUntil) => this.pauseCase(caseId, reason, pauseUntil),
      resumeOutreach: async (caseId) => this.resumeCase(caseId),
      resolveContactTime: async (reference) => resolveRelativeContactTime(reference, this.clock(), this.world.policy).toISOString()
    };
  }

  protected async requestCaseInvestigation(caseId: string) {
    const recoveryCase = this.getCase(caseId);
    const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
    if (!obligation) throw new RepositoryError("NOT_FOUND", "Obligation not found.");
    if (["cancelled", "review_required"].includes(obligation.status) || isFullyPaid(obligation.amountDue, obligation.amountPaid)) throw new RepositoryError("POLICY_BLOCKED", "This case is not eligible for another investigation.");
    const activeJob = this.world.jobs.find((job) => job.caseId === caseId && job.kind === "investigate_case" && ["queued", "running"].includes(job.status));
    if (activeJob) return { status: "already_queued", caseId, jobId: activeJob.id, nextAction: recoveryCase.nextAction };

    const before = summarizeCaseChange(recoveryCase);
    if (recoveryCase.state === "detected") {
      const investigating = transitionCase(recoveryCase, "investigating");
      Object.assign(recoveryCase, { ...investigating, nextAction: "Investigation queued from the Rebound agent", updatedAt: nowIso() });
    }
    const idempotencyKey = `case:${caseId}:chat-investigation:v${recoveryCase.version}`;
    const job: JobRecord = { id: newId("job"), merchantId: this.world.merchant.id, kind: "investigate_case", idempotencyKey, status: "queued", caseId, attempts: 0 };
    this.world.jobs.push(job);
    this.addAudit({ actor: "agent", eventType: "agent.investigation.requested", entityType: "case", entityId: caseId, summary: "The bounded agent queued an evidence investigation; provider inference and any external action remain separate.", before, after: { ...summarizeCaseChange(recoveryCase), jobId: job.id }, sourceIds: [] });

    if (this.fixtureAsync && this.selectedAgentProvider() === "fixture" && this.selectedEvidenceProvider() === "fixture") {
      setTimeout(() => {
        void (async () => {
          const currentJob = this.world.jobs.find((item) => item.id === job.id);
          if (!currentJob || currentJob.status !== "queued") return;
          currentJob.status = "running";
          try {
            await this.investigateCase(caseId, "explicit_investigation");
            currentJob.status = "completed";
          } catch (error) {
            currentJob.status = "failed";
            currentJob.lastError = error instanceof Error ? error.message : "Investigation failed";
          }
        })();
      }, 25);
    }
    return { status: "queued", caseId, jobId: job.id, nextAction: recoveryCase.nextAction };
  }

  async getCustomerPage(publicToken: string): Promise<CustomerPageData | null> {
    const paymentLink = this.world.paymentLinks.find((item) => item.publicToken === publicToken);
    if (!paymentLink || ["cancelled", "expired"].includes(paymentLink.status)) return null;
    const obligation = this.world.obligations.find((item) => item.id === paymentLink.obligationId);
    const recoveryCase = this.world.cases.find((item) => item.obligationId === paymentLink.obligationId);
    const customer = this.world.customers.find((item) => item.id === obligation?.customerId);
    if (!obligation || !recoveryCase || !customer) return null;
    const document = this.world.documents.find((item) => item.id === String(this.world.proposals.find((proposal) => proposal.caseId === recoveryCase.id && proposal.type === "document_response")?.payload.documentId || ""));
    const message = this.world.messages.find((item) => item.caseId === recoveryCase.id && item.direction === "outbound");
    return { merchant: this.world.merchant, customer, obligation, case: recoveryCase, paymentLink, document: document?.customerId === customer.id && document.obligationId === obligation.id && document.permission === "approved_customer_share" ? document : undefined, message, demo: this.isDemoPayment() };
  }

  async decideProposal(input: DecideProposalInput): Promise<ProposalDecisionResult> {
    const proposal = this.getProposal(input.proposalId);
    const recoveryCase = this.getCase(proposal.caseId);
    // A replay of the same proposal is already resolved. Return its recorded
    // result before checking the caller's stale view so an old retry cannot
    // turn an idempotent approval into a misleading conflict.
    if (proposal.status === "executed") return { proposal, case: recoveryCase, deduplicated: true };
    if (input.expectedCaseVersion !== undefined && input.expectedCaseVersion !== recoveryCase.version) {
      proposal.status = "stale";
      this.addAudit({ actor: "system", eventType: "approval.stale", entityType: "proposal", entityId: proposal.id, summary: "Approval rejected because the case changed while it was open.", before: { expectedCaseVersion: input.expectedCaseVersion }, after: { actualCaseVersion: recoveryCase.version }, sourceIds: [proposal.id] });
      throw new RepositoryError("STALE_VERSION", "This proposal is stale. Refresh the case before deciding.", { actualCaseVersion: recoveryCase.version });
    }
    if (proposal.actionVersion !== recoveryCase.version) {
      proposal.status = "stale";
      this.addAudit({ actor: "system", eventType: "approval.stale", entityType: "proposal", entityId: proposal.id, summary: "Approval rejected because the proposal was created for an older case version.", before: { actionVersion: proposal.actionVersion }, after: { actualCaseVersion: recoveryCase.version }, sourceIds: proposal.evidenceIds });
      throw new RepositoryError("STALE_VERSION", "This proposal is stale. Refresh the case before deciding.", { actualCaseVersion: recoveryCase.version });
    }
    if (proposal.status !== "pending" && proposal.status !== "approved") throw new RepositoryError("ALREADY_DONE", `This proposal is already ${proposal.status}.`);
    const approval = this.world.approvals.find((item) => item.proposalId === proposal.id);
    if (input.decision === "reject") {
      proposal.status = "rejected";
      proposal.decidedAt = nowIso();
      if (approval) { approval.decision = "rejected"; approval.decidedBy = "merchant"; approval.rationale = input.rationale || "Rejected by merchant"; approval.decidedAt = proposal.decidedAt; }
      const before = summarizeCaseChange(recoveryCase);
      const paused = recoveryCase.state === "awaiting_approval" ? transitionCase(recoveryCase, "paused") : recoveryCase;
      Object.assign(recoveryCase, { ...paused, pauseReason: "Merchant rejected the proposed action", nextAction: "Review the case and choose a different action", updatedAt: nowIso() });
      this.cancelCaseJobs(recoveryCase.id, "Merchant rejected proposal");
      this.addAudit({ actor: "merchant", eventType: "proposal.rejected", entityType: "proposal", entityId: proposal.id, summary: "Merchant rejected the proposed external action; follow-ups were paused.", before, after: summarizeCaseChange(recoveryCase), sourceIds: proposal.evidenceIds });
      return { proposal, case: recoveryCase };
    }
    const mergedPayload = { ...proposal.payload, ...input.editedPayload };
    const policyResult = evaluateProposal(this.world.policy, this.caseForPolicy(recoveryCase), contactPolicyInput(this.world, recoveryCase, { channel: proposal.channel, type: proposal.type, discountMinor: Number(mergedPayload.discountMinor || 0), externalAction: proposal.channel === "email" }, this.clock));
    if (policyResult.decision === "blocked" && !canDeferContact(policyResult)) {
      proposal.status = "blocked";
      proposal.policy = policyResult;
      this.addAudit({ actor: "system", eventType: "proposal.blocked", entityType: "proposal", entityId: proposal.id, summary: policyResult.reason, after: policyResult as unknown as Record<string, unknown>, sourceIds: proposal.evidenceIds });
      throw new RepositoryError("POLICY_BLOCKED", policyResult.reason, policyResult as unknown as Record<string, unknown>);
    }
    proposal.payload = mergedPayload;
    proposal.policy = policyResult;
    proposal.status = "approved";
    proposal.decidedAt = nowIso();
    if (approval) { approval.decision = "approved"; approval.decidedBy = "merchant"; approval.editedPayload = input.editedPayload; approval.rationale = input.rationale; approval.decidedAt = proposal.decidedAt; }
    this.addAudit({ actor: "merchant", eventType: "proposal.approved", entityType: "proposal", entityId: proposal.id, summary: input.editedPayload ? "Merchant edited and approved the proposed action." : "Merchant approved the proposed action.", after: { type: proposal.type, edited: Boolean(input.editedPayload) }, sourceIds: proposal.evidenceIds });
    return this.executeApprovedProposal(proposal, recoveryCase);
  }

  protected async executeApprovedProposal(proposal: Proposal, recoveryCase: RecoveryCase): Promise<ProposalDecisionResult> {
    if (proposal.status === "executed") return { proposal, case: recoveryCase, deduplicated: true };
    const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
    if (!obligation) throw new RepositoryError("NOT_FOUND", "Obligation not found.");
    if (proposal.channel === "email" && ["cancelled", "review_required"].includes(obligation.status)) {
      proposal.status = "blocked";
      this.addAudit({ actor: "system", eventType: "proposal.blocked", entityType: "proposal", entityId: proposal.id, summary: "The obligation is cancelled or requires reconciliation; no ordinary customer-facing action may execute.", after: { rule: "cancelled_or_review_required", obligationStatus: obligation.status }, sourceIds: proposal.evidenceIds });
      throw new RepositoryError("POLICY_BLOCKED", "The obligation is cancelled or requires reconciliation; customer outreach is stopped.");
    }
    if (proposal.channel === "email" && !isOrdinaryChasingEligible({ ...recoveryCase, incidentId: this.isIncidentResolved(recoveryCase.incidentId) ? undefined : recoveryCase.incidentId }, this.world.policy, this.clock())) {
      proposal.status = "blocked";
      throw new RepositoryError("POLICY_BLOCKED", "The case is no longer eligible for ordinary outreach.");
    }
    if (proposal.channel === "email") {
      const policyResult = evaluateProposal(this.world.policy, this.caseForPolicy(recoveryCase), contactPolicyInput(this.world, recoveryCase, { channel: proposal.channel, type: proposal.type, discountMinor: Number(proposal.payload.discountMinor || 0), externalAction: true }, this.clock));
      if (policyResult.decision === "blocked") {
        proposal.policy = policyResult;
        if (canDeferContact(policyResult)) return this.deferApprovedEmail(proposal, recoveryCase, policyResult);
        proposal.status = "blocked";
        this.addAudit({ actor: "system", eventType: "proposal.blocked", entityType: "proposal", entityId: proposal.id, summary: policyResult.reason, after: policyResult as unknown as Record<string, unknown>, sourceIds: proposal.evidenceIds });
        throw new RepositoryError("POLICY_BLOCKED", policyResult.reason, policyResult as unknown as Record<string, unknown>);
      }
    }
    let message: Message | undefined;
    let paymentLink: PaymentLink | undefined;
    let preserveQueuedWork = false;
    const payload = proposal.payload;
    if (proposal.channel === "email") {
      const customer = this.world.customers.find((item) => item.id === recoveryCase.customerId);
      if (!customer || !obligation) throw new RepositoryError("NOT_FOUND", "Customer or obligation not found.");
      const outstanding = Math.max(0, obligation.amountDue - obligation.amountPaid);
      if (!outstanding) {
        proposal.status = "blocked";
        this.addAudit({ actor: "system", eventType: "proposal.blocked", entityType: "proposal", entityId: proposal.id, summary: "The obligation was fully paid before the approved customer-facing action could execute.", after: { rule: "paid_or_closed" }, sourceIds: proposal.evidenceIds });
        throw new RepositoryError("ALREADY_DONE", "This obligation is already fully paid; no customer-facing action may be sent.");
      }
      if (proposal.recipient.trim().toLowerCase() !== customer.email.trim().toLowerCase()) {
        proposal.status = "blocked";
        this.addAudit({ actor: "system", eventType: "proposal.blocked", entityType: "proposal", entityId: proposal.id, summary: "The approved recipient no longer matches the scoped customer email.", after: { rule: "recipient_scope" }, sourceIds: proposal.evidenceIds });
        throw new RepositoryError("POLICY_BLOCKED", "The approved recipient no longer matches the scoped customer email.");
      }
      if (payload.amountMinor !== undefined && Number(payload.amountMinor) !== outstanding) {
        proposal.status = "stale";
        this.addAudit({ actor: "system", eventType: "approval.stale", entityType: "proposal", entityId: proposal.id, summary: "The approved amount no longer matches the current outstanding balance.", after: { rule: "outstanding_balance", expectedOutstanding: outstanding, proposalAmount: Number(payload.amountMinor) }, sourceIds: proposal.evidenceIds });
        throw new RepositoryError("STALE_VERSION", "The proposal amount no longer matches the current outstanding balance.", { expectedOutstanding: outstanding, proposalAmount: Number(payload.amountMinor) });
      }
    }
    if (proposal.channel === "system") {
      if (proposal.type === "pause_or_resume") {
        const action = String(payload.action || payload.intent || "pause").toLowerCase();
        if (action === "resume") {
          await this.resumeCase(recoveryCase.id);
          this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "investigate_case", idempotencyKey: `case:${recoveryCase.id}:resume:v${recoveryCase.version}`, status: "queued", caseId: recoveryCase.id, attempts: 0 });
          preserveQueuedWork = true;
        } else {
          await this.pauseCase(recoveryCase.id, String(payload.reason || "Agent proposed pausing outreach"), payload.pauseUntil ? String(payload.pauseUntil) : undefined);
        }
      } else if (proposal.type === "promise_schedule") {
        const pauseUntil = String(payload.promisedAt || payload.pauseUntil || "");
        if (!pauseUntil || Number.isNaN(new Date(pauseUntil).getTime())) throw new RepositoryError("POLICY_BLOCKED", "A payment promise must include a valid recheck time.");
        await this.pauseCase(recoveryCase.id, String(payload.reason || "Customer promise-to-pay"), pauseUntil);
        this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "recheck_promise", idempotencyKey: `case:${recoveryCase.id}:promise:${pauseUntil}`, status: "queued", caseId: recoveryCase.id, runAfter: pauseUntil, attempts: 0 });
        preserveQueuedWork = true;
      } else if (proposal.type === "escalation") {
        if (recoveryCase.state !== "escalated") {
          try { Object.assign(recoveryCase, transitionCase(recoveryCase, "escalated")); } catch { throw new RepositoryError("ILLEGAL_TRANSITION", "This case cannot be escalated from its current state."); }
        }
        recoveryCase.nextAction = String(payload.reason || "Merchant review required");
        recoveryCase.updatedAt = nowIso();
        this.cancelCaseJobs(recoveryCase.id, "Escalated for merchant review");
      }
    }
    if (proposal.channel === "email") {
      const customer = this.world.customers.find((item) => item.id === recoveryCase.customerId);
      if (!customer) throw new RepositoryError("NOT_FOUND", "Customer not found.");
      const subject = String(payload.subject || "Northstar Office recovery update");
      const body = String(payload.body || "Please review your outstanding Northstar Office payment.");
      if (payload.documentId) {
        const document = this.world.documents.find((item) => item.id === String(payload.documentId));
        if (!document || document.customerId !== customer.id || document.obligationId !== recoveryCase.obligationId || document.permission !== "approved_customer_share") {
          proposal.status = "blocked";
          this.addAudit({ actor: "system", eventType: "proposal.blocked", entityType: "proposal", entityId: proposal.id, summary: "The approved document failed customer, obligation or permission validation; no message was sent.", after: { rule: "document_scope_or_permission", documentId: String(payload.documentId) }, sourceIds: proposal.evidenceIds });
          throw new RepositoryError("POLICY_BLOCKED", "The document is not approved for this customer or obligation.");
        }
      }
      // Establish the payment-link idempotency record before sending the
      // message. A transient email failure can then retry without creating a
      // second link, while a link failure never sends a premature email.
      if (payload.createPaymentLink) paymentLink = await this.findOrCreatePaymentLink(recoveryCase);
      const config = runtimeConfig();
      const secureDocumentUrl = payload.documentId && paymentLink ? `${config.appBaseUrl}/api/documents/${encodeURIComponent(String(payload.documentId))}?token=${encodeURIComponent(paymentLink.publicToken)}` : undefined;
      const customerPaymentUrl = paymentLink ? (paymentLink.url.startsWith("http") ? paymentLink.url : `${config.appBaseUrl}${paymentLink.url}`) : undefined;
      const deliveredBody = [body, secureDocumentUrl ? `Delivery confirmation: ${secureDocumentUrl}` : undefined, customerPaymentUrl ? `Payment route: ${customerPaymentUrl}` : undefined].filter(Boolean).join("\n\n");
      const emailAdapter = this.emailAdapter();
      const threadId = this.world.messages.find((item) => item.caseId === recoveryCase.id && item.threadId)?.threadId;
      const providerMessage = await emailAdapter.sendApproved({ to: customer.email, subject, body: deliveredBody, approvalId: this.world.approvals.find((item) => item.proposalId === proposal.id)?.id || proposal.id, threadId });
      message = { id: newId("message"), merchantId: this.world.merchant.id, caseId: recoveryCase.id, obligationId: recoveryCase.obligationId, direction: "outbound", channel: "email", providerId: providerMessage.providerId, threadId: providerMessage.threadId || threadId, subject, body: deliveredBody, participants: ["collections@northstar.example", customer.email], from: "collections@northstar.example", to: [customer.email], providerMode: providerMessage.providerMode, providerUrl: providerMessage.providerMode === "live" ? `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(providerMessage.providerId)}` : undefined, sentAt: providerMessage.sentAt };
      this.world.messages.unshift(message);
      this.addAudit({ actor: "connector", eventType: "email.sent", entityType: "message", entityId: message.id, summary: `${providerMessage.providerMode === "fixture" ? "Fixture simulation recorded" : "Provider sent"} approved email with obligation-scoped document and payment routes.`, after: { providerId: providerMessage.providerId, threadId: message.threadId, providerMode: providerMessage.providerMode, recipient: customer.email, documentUrl: secureDocumentUrl, paymentUrl: customerPaymentUrl, proposalId: proposal.id, approvalId: this.world.approvals.find((item) => item.proposalId === proposal.id)?.id || proposal.id }, sourceIds: [proposal.id], demo: providerMessage.providerMode === "fixture", provider: this.selectedEvidenceProvider() });
    }
    if (proposal.channel === "email" && (recoveryCase.state === "awaiting_approval" || recoveryCase.state === "proposed" || recoveryCase.state === "investigating")) {
      const contacted = transitionCase(recoveryCase, "contacted");
      Object.assign(recoveryCase, { ...contacted, nextAction: paymentLink ? "Wait for customer-authorized payment; verification will update the ledger" : "Wait for the customer response", updatedAt: nowIso(), pauseReason: undefined, pauseUntil: undefined });
    }
    proposal.status = "executed";
    if (!preserveQueuedWork) this.cancelCaseJobs(recoveryCase.id, "Action executed; wait for authoritative response");
    this.addAudit({ actor: "system", eventType: "proposal.executed", entityType: "proposal", entityId: proposal.id, summary: message ? `Approved ${proposal.channel} sent to ${message.participants.at(-1)}; payment state remains unverified.` : "Approved proposal executed.", after: { messageId: message?.id, paymentLinkId: paymentLink?.id, case: summarizeCaseChange(recoveryCase) }, sourceIds: proposal.evidenceIds });
    return { proposal, case: recoveryCase, message, paymentLink };
  }

  protected deferApprovedEmail(proposal: Proposal, recoveryCase: RecoveryCase, policyResult: { reason: string; rules: string[] }): ProposalDecisionResult {
    const context = contactPolicyInput(this.world, recoveryCase, { channel: "email", type: proposal.type, externalAction: true }, this.clock);
    const now = context.now || policyNow(this.world, this.clock);
    const lastContactAt = context.lastContactAt ? new Date(context.lastContactAt).getTime() : now.getTime();
    const notBefore = new Date(Math.max(now.getTime(), lastContactAt + this.world.policy.minimumSpacingHours * 60 * 60 * 1000));
    const runAfter = nextContactWindowStart(this.world.policy, notBefore);
    if (!runAfter) {
      proposal.status = "blocked";
      throw new RepositoryError("POLICY_BLOCKED", "The merchant contact window could not be calculated safely.");
    }
    const idempotencyKey = `proposal:${proposal.id}:email:v${proposal.actionVersion}`;
    const existing = this.world.jobs.find((job) => job.idempotencyKey === idempotencyKey);
    for (const job of this.world.jobs) {
      if (job.proposalId === proposal.id && job.idempotencyKey !== idempotencyKey && ["queued", "running"].includes(job.status)) {
        job.status = "cancelled";
        job.lastError = "Superseded by the policy-gated contact retry.";
      }
    }
    if (existing) {
      existing.status = "queued";
      existing.runAfter = runAfter.toISOString();
      existing.lastError = undefined;
    } else {
      this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "send_email", idempotencyKey, status: "queued", caseId: recoveryCase.id, proposalId: proposal.id, runAfter: runAfter.toISOString(), attempts: 0 });
    }
    recoveryCase.nextAction = `Policy-gated contact retry after ${runAfter.toISOString()}`;
    recoveryCase.updatedAt = nowIso();
    this.addAudit({ actor: "system", eventType: "proposal.deferred", entityType: "proposal", entityId: proposal.id, summary: `External contact deferred by policy until ${runAfter.toISOString()}.`, after: { runAfter: runAfter.toISOString(), rules: policyResult.rules }, sourceIds: proposal.evidenceIds });
    return { proposal, case: recoveryCase, deduplicated: true };
  }

  protected isIncidentResolved(incidentId?: string) {
    return Boolean(incidentId && this.world.incidents.find((incident) => incident.id === incidentId)?.status === "resolved");
  }

  protected async findOrCreatePaymentLink(recoveryCase: RecoveryCase) {
    const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
    if (!obligation) throw new RepositoryError("NOT_FOUND", "Obligation not found.");
    const outstanding = Math.max(0, obligation.amountDue - obligation.amountPaid);
    if (!outstanding) throw new RepositoryError("ALREADY_DONE", "This obligation has no outstanding balance.");
    const existing = this.world.paymentLinks.find((item) => item.obligationId === obligation.id && ["created", "partially_paid"].includes(item.status) && item.amount > item.amountPaid);
    if (existing) return existing;
    const publicToken = `demo-${randomBytes(18).toString("base64url")}`;
    const referenceId = obligation.orderRef || obligation.invoiceRef || obligation.id;
    const customer = this.world.customers.find((item) => item.id === obligation.customerId);
    const providerLink = this.isDemoPayment() ? { providerLinkId: `plink_fixture_${publicToken}`, shortUrl: `/pay/${publicToken}`, status: "created" } : await this.paymentAdapter().createPaymentLink({ amount: outstanding, currency: obligation.currency, referenceId, description: `Northstar Office ${referenceId}`, customer: { name: customer?.displayName || "Customer", email: customer?.email || "" }, acceptPartial: true });
    const link: PaymentLink = { id: newId("plink"), merchantId: this.world.merchant.id, obligationId: obligation.id, razorpayLinkId: providerLink.providerLinkId, referenceId, amount: outstanding, amountPaid: 0, status: "created", url: providerLink.shortUrl, publicToken, acceptPartial: true, expiresAt: new Date(this.clock().getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), createdAt: nowIso() };
    this.world.paymentLinks.push(link);
    this.addAudit({ actor: "system", eventType: "payment_link.created", entityType: "payment_link", entityId: link.id, summary: `${this.isDemoPayment() ? "Demo simulation: " : ""}created one Standard Payment Link for ${formatMoney(link.amount, obligation.currency)}; it is not a payment confirmation.`, after: { referenceId: link.referenceId, url: link.url, status: link.status, provider: this.selectedPaymentProvider() }, sourceIds: [recoveryCase.obligationId], demo: this.isDemoPayment(), provider: this.selectedPaymentProvider() });
    return link;
  }

  protected cancelCaseJobs(caseId: string, reason: string) {
    for (const job of this.world.jobs) {
      if (job.caseId === caseId && ["queued", "running"].includes(job.status)) {
        job.status = "cancelled";
        job.lastError = reason;
      }
    }
  }

  async investigateCase(caseId: string, invocationReason: AgentInvocationReason = "explicit_investigation") {
    const recoveryCase = this.getCase(caseId);
    const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
    if (!obligation) throw new RepositoryError("NOT_FOUND", "Obligation not found.");
    if (["cancelled", "review_required"].includes(obligation.status) || isFullyPaid(obligation.amountDue, obligation.amountPaid)) {
      recoveryCase.nextAction = obligation.status === "cancelled" ? "No action — obligation cancelled" : isFullyPaid(obligation.amountDue, obligation.amountPaid) ? "No action — obligation already paid" : "Reconciliation required before any outreach";
      this.addAudit({ actor: "system", eventType: "investigation.stopped", entityType: "case", entityId: caseId, summary: "Investigation stopped before proposal creation because current financial state is not eligible for ordinary recovery.", after: { obligationStatus: obligation.status, amountDue: obligation.amountDue, amountPaid: obligation.amountPaid }, sourceIds: [] });
      return { runId: `stopped:${caseId}`, proposal: undefined };
    }
    const before = summarizeCaseChange(recoveryCase);
    this.correlatePendingSignals();
    await this.syncConnectorEvidence(recoveryCase);
    const inputHash = canonicalAgentInputHash(this.world, recoveryCase, this.clock);
    const previousRun = recoveryCase.lastAgentRunId ? this.world.agentRuns.find((item) => item.id === recoveryCase.lastAgentRunId) : undefined;
    if (recoveryCase.lastAgentInputHash === inputHash && previousRun && ["completed", "escalated"].includes(previousRun.status)) {
      this.addAudit({ actor: "agent", eventType: "agent.invocation.skipped", entityType: "case", entityId: caseId, summary: "Investigation skipped because the canonical case, evidence, policy and provider input hash is unchanged.", after: { inputHash, previousRunId: previousRun.id, reason: "unchanged_input" }, sourceIds: [], provider: previousRun.provider, invocationReason, inputHash });
      return { runId: previousRun.id, proposal: this.world.proposals.find((item) => item.caseId === caseId && ["pending", "approved", "executed", "blocked"].includes(item.status)), skipped: true };
    }
    const runId = newId("run");
    const selectedProvider = this.selectedAgentProvider();
    const run: AgentRun = { id: runId, merchantId: this.world.merchant.id, caseId, provider: selectedProvider, model: selectedProvider === "fixture" ? "scripted-fixture-recovery-v1" : selectedProvider === "fireworks" ? runtimeConfig().fireworksModel : "codex-app-server", status: "running", stepCount: 0, toolCallSummaries: [], invocationReason, inputHash, startedAt: nowIso() };
    this.world.agentRuns.unshift(run);
    this.addAudit({ actor: "agent", eventType: "agent.invocation.started", entityType: "case", entityId: caseId, summary: `Selected ${selectedProvider} recovery provider for an explicit, bounded investigation.`, after: { runId, provider: selectedProvider, reason: invocationReason, inputHash }, sourceIds: [], provider: selectedProvider, invocationReason, inputHash });
    if (selectedProvider !== "fixture") return this.investigateLiveCase(recoveryCase, run, before, inputHash);
    try {
      const fixtureResult = await runRecoveryAgent({ context: {} as RecoveryToolContext, workflow: recoveryCase.workflow, caseId, inputHash, invocationReason, prompt: `Review ${caseId} using the deterministic fixture provider. Create no external side effects.` });
      run.toolCallSummaries.push(...(fixtureResult.toolCallSummaries || []));
      const latestInbound = this.world.messages.filter((item) => item.caseId === caseId && item.direction === "inbound").sort((a, b) => (b.receivedAt || "").localeCompare(a.receivedAt || ""))[0];
      const inboundText = `${latestInbound?.subject || ""} ${latestInbound?.body || ""}`.toLowerCase();
      const diagnosisPending = recoveryCase.confidence === 0 && recoveryCase.reason === "Evidence review is pending";
      const failedSignal = this.world.signals.find((signal) => (signal.caseId === caseId || signal.obligationId === recoveryCase.obligationId) && signal.type === "payment_failed");
      if (diagnosisPending && !latestInbound && (failedSignal || this.world.paymentAttempts.some((attempt) => attempt.obligationId === recoveryCase.obligationId && attempt.status === "failed"))) {
        recoveryCase.blocker = "payment_failed";
        recoveryCase.confidence = failedSignal?.correlationStatus === "matched" ? 1 : 0.99;
        recoveryCase.reason = "Razorpay payment failure was matched to the canonical purchase evidence";
        recoveryCase.nextAction = "Review the failed attempt and one recovery proposal";
        recoveryCase.updatedAt = nowIso();
        this.addAudit({ actor: "agent", eventType: "blocker.classified", entityType: "case", entityId: caseId, summary: "Classified the purchase blocker from retrieved Razorpay failure evidence.", after: { blocker: recoveryCase.blocker, signalId: failedSignal?.id, paymentAttemptId: this.world.paymentAttempts.find((attempt) => attempt.obligationId === recoveryCase.obligationId)?.id }, sourceIds: [failedSignal?.id, this.world.paymentAttempts.find((attempt) => attempt.obligationId === recoveryCase.obligationId)?.id].filter((id): id is string => Boolean(id)) });
      }
      if (inboundText.includes("opt out") || inboundText.includes("do not contact") || inboundText.includes("don't contact")) recoveryCase.blocker = "opted_out";
      else if (inboundText.includes("dispute") || inboundText.includes("quantity mismatch")) recoveryCase.blocker = "dispute";
      else if (inboundText.includes("friday") && inboundText.includes("do not follow")) recoveryCase.blocker = "promise_to_pay";
      else if (inboundText.includes("can't pay") || inboundText.includes("cannot pay") || inboundText.includes("unable to pay")) recoveryCase.blocker = "inability_to_pay";
      else if (inboundText.includes("delivery confirmation") || inboundText.includes("signed delivery")) recoveryCase.blocker = "missing_document";
      if (latestInbound && recoveryCase.blocker === "missing_document") {
        recoveryCase.reason = "Customer finance cannot release the invoice until signed delivery confirmation is shared";
        recoveryCase.confidence = 0.99;
        recoveryCase.nextAction = "Review the retrieved email and matched delivery document";
        recoveryCase.updatedAt = nowIso();
        this.addAudit({ actor: "agent", eventType: "blocker.classified", entityType: "case", entityId: caseId, summary: "Classified the invoice blocker from retrieved inbound email content.", after: { blocker: recoveryCase.blocker, messageId: latestInbound.id, subject: latestInbound.subject }, sourceIds: [latestInbound.id] });
      }
      if (["dispute", "opted_out", "inability_to_pay"].includes(recoveryCase.blocker)) {
        if (!(["closed", "recovered", "escalated"] as RecoveryCase["state"][]).includes(recoveryCase.state)) {
          Object.assign(recoveryCase, transitionCase(recoveryCase, "escalated"));
        }
        recoveryCase.pauseReason = recoveryCase.blocker === "dispute" ? "Customer dispute" : recoveryCase.blocker === "opted_out" ? "Customer opted out of collection contact" : "Customer inability to pay";
        recoveryCase.nextAction = recoveryCase.blocker === "dispute" ? "Review dispute evidence; ordinary reminders stopped" : recoveryCase.blocker === "opted_out" ? "Do not contact; route only to merchant review" : "Review an appropriate payment arrangement; ordinary reminders stopped";
        recoveryCase.updatedAt = nowIso();
        this.cancelCaseJobs(caseId, "Changed customer circumstance requires stopped ordinary outreach");
        run.toolCallSummaries.push("search_customer_messages", "stop_ordinary_outreach", "finish_investigation");
        run.stepCount = Math.min(5, run.toolCallSummaries.length);
        this.finishAgentRun(run, recoveryCase);
        this.addAudit({ actor: "agent", eventType: "changed_circumstance.detected", entityType: "case", entityId: caseId, summary: "Inbound customer context changed the blocker; ordinary outreach was stopped and the case was routed to review.", after: { blocker: recoveryCase.blocker, state: recoveryCase.state, messageId: latestInbound?.id }, sourceIds: latestInbound ? [latestInbound.id] : [] });
        return { runId, proposal: undefined };
      }
      if (recoveryCase.blocker === "promise_to_pay") {
        const explicitDate = latestInbound?.body.match(/\b\d{4}-\d{2}-\d{2}(?:T[^\s]+)?/u)?.[0];
        const requestedDate = explicitDate || (latestInbound?.body.match(/friday/i) ? "Friday" : undefined);
        const promisedAt = requestedDate ? resolveRelativeContactTime(requestedDate, this.clock(), this.world.policy) : recoveryCase.pauseUntil ? new Date(recoveryCase.pauseUntil) : undefined;
        if (promisedAt && promisedAt.getTime() > this.clock().getTime()) {
          const pauseUntil = promisedAt.toISOString();
          await this.pauseCase(caseId, `Customer promise-to-pay; source ${latestInbound?.providerId || "case record"}`, pauseUntil);
          const idempotencyKey = `case:${caseId}:promise:${pauseUntil}`;
          const existingJob = this.world.jobs.find((job) => job.idempotencyKey === idempotencyKey);
          if (existingJob) Object.assign(existingJob, { status: "queued" as const, runAfter: pauseUntil, lastError: undefined });
          else this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "recheck_promise", idempotencyKey, status: "queued", caseId, runAfter: pauseUntil, attempts: 0 });
          run.toolCallSummaries.push("search_customer_messages", "record_promise_date", "finish_investigation");
          run.stepCount = Math.min(5, run.toolCallSummaries.length);
          this.finishAgentRun(run, recoveryCase);
          this.addAudit({ actor: "agent", eventType: "promise_to_pay.recorded", entityType: "case", entityId: caseId, summary: "Customer promise-to-pay was recorded with a policy-safe recheck; it is not payment authorization.", after: { promisedAt: pauseUntil, sourceMessageId: latestInbound?.id, sourceProviderId: latestInbound?.providerId }, sourceIds: latestInbound ? [latestInbound.id] : [] });
          return { runId, proposal: undefined };
        }
      }
      if (["detected", "paused", "escalated"].includes(recoveryCase.state)) {
        const investigating = transitionCase(recoveryCase, "investigating");
        Object.assign(recoveryCase, { ...investigating, nextAction: "Read payment, message and policy evidence", updatedAt: nowIso(), pauseReason: undefined, pauseUntil: undefined });
      }
      run.toolCallSummaries.push("read_case_summary");
      run.stepCount += 1;
      if (recoveryCase.blocker === "missing_document") run.toolCallSummaries.push("search_customer_messages", "search_case_documents", "propose_document_response");
      else if (recoveryCase.blocker === "payment_failed") run.toolCallSummaries.push("read_payment_failure", "find_related_signals", "propose_recovery_message");
      else if (recoveryCase.blocker === "promise_to_pay") run.toolCallSummaries.push("search_customer_messages", "propose_promise_schedule");
      else run.toolCallSummaries.push("read_incident_context", "finish_investigation");
      run.stepCount = Math.min(5, run.stepCount + run.toolCallSummaries.length - 1);
      let proposal: Proposal | undefined;
      if (recoveryCase.blocker === "payment_failed" && !this.world.proposals.some((item) => item.caseId === caseId && item.status !== "rejected")) proposal = this.createRecoveryProposal(recoveryCase, runId);
      if (recoveryCase.blocker === "missing_document" && !this.world.proposals.some((item) => item.caseId === caseId && item.status !== "rejected")) proposal = this.createDocumentProposal(recoveryCase, runId);
      if (proposal) {
        const proposed = transitionCase(recoveryCase, "proposed");
        const awaiting = transitionCase({ ...proposed }, "awaiting_approval");
        Object.assign(recoveryCase, { ...awaiting, nextAction: proposal.intendedOutcome, updatedAt: nowIso() });
        proposal.actionVersion = recoveryCase.version;
        this.finishAgentRun(run, recoveryCase);
        this.addAudit({ actor: "agent", eventType: "investigation.completed", entityType: "case", entityId: caseId, summary: `Fixture agent investigated the case in ${run.stepCount} bounded steps and created a reviewable proposal.`, before, after: summarizeCaseChange(recoveryCase), sourceIds: proposal.evidenceIds });
      } else {
        this.finishAgentRun(run, recoveryCase);
      }
      return { runId, proposal };
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : "Unknown agent failure";
      run.finishedAt = nowIso();
      recoveryCase.lastAgentRunId = run.id;
      this.addAudit({ actor: "agent", eventType: "investigation.failed", entityType: "case", entityId: caseId, summary: "Investigation failed safely; no external action was executed.", after: { runId, error: run.error }, sourceIds: [] });
      throw error;
    }
  }

  protected async investigateLiveCase(recoveryCase: RecoveryCase, run: AgentRun, before: ReturnType<typeof summarizeCaseChange>, inputHash: string) {
    try {
      if (["detected", "paused", "escalated"].includes(recoveryCase.state)) {
        const investigating = transitionCase(recoveryCase, "investigating");
        Object.assign(recoveryCase, { ...investigating, nextAction: "Read payment, message and policy evidence", updatedAt: nowIso(), pauseReason: undefined, pauseUntil: undefined });
      }
      const context: RecoveryToolContext = {
        readCaseSummary: async (caseId) => {
          const view = await this.getCaseView(caseId);
          if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
          return view;
        },
        readPaymentFailure: async (caseId) => {
          const view = await this.getCaseView(caseId);
          if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
          return view.paymentAttempt ? { id: view.paymentAttempt.id, providerPaymentId: view.paymentAttempt.razorpayPaymentId, amount: view.paymentAttempt.amount, status: view.paymentAttempt.status, errorCode: view.paymentAttempt.errorCode, errorDescription: view.paymentAttempt.errorDescription, errorSource: view.paymentAttempt.errorSource, errorStep: view.paymentAttempt.errorStep } : { status: "no_attempt_recorded" };
        },
        findRelatedSignals: async (caseId) => {
          const view = await this.getCaseView(caseId);
          if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
          return view.signals.map((signal) => ({ id: signal.id, type: signal.type, source: signal.source, externalId: signal.externalId, payload: signal.payload, occurredAt: signal.occurredAt, correlationStatus: signal.correlationStatus }));
        },
        searchCustomerMessages: async (caseId, query) => {
          const view = await this.getCaseView(caseId);
          if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
          const normalized = query?.toLowerCase();
          return view.messages.filter((message) => !normalized || `${message.subject} ${message.body}`.toLowerCase().includes(normalized)).map((message) => ({ id: message.id, direction: message.direction, subject: message.subject, body: message.body.slice(0, 2000), participants: message.participants, receivedAt: message.receivedAt, sentAt: message.sentAt }));
        },
        searchCaseDocuments: async (caseId, query) => {
          const view = await this.getCaseView(caseId);
          if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
          const normalized = query?.toLowerCase();
          return view.documents.filter((document) => document.customerId === view.customer.id && document.obligationId === view.obligation.id && (!normalized || `${document.name} ${document.extractedText}`.toLowerCase().includes(normalized))).map((document) => ({ id: document.id, name: document.name, mimeType: document.mimeType, permission: document.permission, extractedText: document.extractedText.slice(0, 2500), checksum: document.checksum }));
        },
        readActivePolicies: async () => this.world.policy,
        readIncidentContext: async (caseId) => {
          const view = await this.getCaseView(caseId);
          if (!view) throw new RepositoryError("NOT_FOUND", "Recovery case not found.");
          return view.incident ? { id: view.incident.id, provider: view.incident.provider, method: view.incident.method, confirmation: view.incident.confirmation, status: view.incident.status, summary: view.incident.summary, evidence: view.incident.evidence } : { status: "no_incident" };
        },
        createProposal: (input) => this.createAgentProposal(input, run.id)
      };
      const result = await runRecoveryAgent({ context, workflow: recoveryCase.workflow, caseId: recoveryCase.id, inputHash, invocationReason: run.invocationReason || "explicit_investigation", prompt: `Investigate recovery case ${recoveryCase.id}. Read the scoped evidence, distinguish facts from inference, and create at most one schema-valid reviewable proposal for the least aggressive effective action. Never claim payment success or execute an external action.` });
      run.toolCallSummaries.push(...(result.toolCallSummaries || []));
      run.stepCount = Math.min(5, Math.max(1, result.steps));
      const remoteProposal = result.proposal;
      if (remoteProposal && !this.world.proposals.some((item) => item.modelRunId === run.id)) await this.createAgentProposal({ ...remoteProposal, caseId: recoveryCase.id }, run.id);
      const proposal = this.world.proposals.find((item) => item.modelRunId === run.id);
      if (proposal?.status === "blocked") {
        this.finishAgentRun(run, recoveryCase, result.usage);
        recoveryCase.nextAction = proposal.policy.reason;
        return { runId: run.id, proposal };
      }
      if (proposal) {
        if (proposal.type === "document_response") {
          recoveryCase.blocker = "missing_document";
          recoveryCase.confidence = 0.95;
          recoveryCase.reason = "Customer payment is blocked pending the matched delivery document";
        } else if (proposal.type === "recovery_message" && this.world.paymentAttempts.some((attempt) => attempt.obligationId === recoveryCase.obligationId && attempt.status === "failed")) {
          recoveryCase.blocker = "payment_failed";
          recoveryCase.confidence = 0.99;
          recoveryCase.reason = "A failed Razorpay authorization was matched to this purchase";
        }
        const proposed = transitionCase(recoveryCase, "proposed");
        const awaiting = transitionCase({ ...proposed }, "awaiting_approval");
        Object.assign(recoveryCase, { ...awaiting, nextAction: proposal.intendedOutcome, updatedAt: nowIso() });
        proposal.actionVersion = recoveryCase.version;
      } else {
        recoveryCase.nextAction = "No safe external action proposed; merchant review required";
        recoveryCase.updatedAt = nowIso();
      }
      this.finishAgentRun(run, recoveryCase, result.usage);
      this.addAudit({ actor: "agent", eventType: "investigation.completed", entityType: "case", entityId: recoveryCase.id, summary: `${run.provider} agent completed a bounded ${run.stepCount}-step evidence review; external actions remain behind policy and approval.`, after: summarizeCaseChange(recoveryCase), sourceIds: proposal?.evidenceIds || [], provider: run.provider, invocationReason: run.invocationReason, inputHash: run.inputHash, usage: run.usage });
      return { runId: run.id, proposal };
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : "Unknown live agent failure";
      run.finishedAt = nowIso();
      recoveryCase.lastAgentRunId = run.id;
      this.addAudit({ actor: "agent", eventType: "investigation.failed", entityType: "case", entityId: recoveryCase.id, summary: "Live investigation failed safely; no external action was executed and no fixture fallback was used.", after: { runId: run.id, error: run.error }, sourceIds: [] });
      throw error;
    }
  }

  protected async createAgentProposal(input: Parameters<RecoveryToolContext["createProposal"]>[0], modelRunId: string): Promise<Proposal> {
    const recoveryCase = this.getCase(input.caseId);
    if (input.channel === "email" && input.payload.documentId) {
      const document = this.world.documents.find((item) => item.id === String(input.payload.documentId));
      if (!document || document.customerId !== recoveryCase.customerId || document.obligationId !== recoveryCase.obligationId || document.permission !== "approved_customer_share") throw new RepositoryError("POLICY_BLOCKED", "The document is not approved for this customer or obligation.");
    }
    const policy = evaluateProposal(this.world.policy, this.caseForPolicy(recoveryCase), contactPolicyInput(this.world, recoveryCase, { channel: input.channel, type: input.type, discountMinor: Number(input.payload.discountMinor || 0), externalAction: input.channel === "email" }, this.clock));
    const proposal: Proposal = { id: newId("proposal"), merchantId: this.world.merchant.id, caseId: recoveryCase.id, obligationId: recoveryCase.obligationId, type: input.type, intendedOutcome: input.intendedOutcome, recipient: input.recipient, scope: input.scope, channel: input.channel, payload: input.payload, evidenceIds: input.evidenceIds, uncertainty: input.uncertainty, explanation: input.explanation, policy, requiresApproval: policy.decision === "approval_required", status: policy.decision === "blocked" ? "blocked" : "pending", modelRunId, actionVersion: recoveryCase.version, createdAt: nowIso() };
    this.world.proposals.unshift(proposal);
    if (proposal.requiresApproval) this.world.approvals.unshift({ id: newId("approval"), proposalId: proposal.id, requestedBy: "agent", decision: "pending", createdAt: nowIso() });
    this.addAudit({ actor: "agent", eventType: "proposal.created", entityType: "proposal", entityId: proposal.id, summary: policy.decision === "blocked" ? `Live agent proposal blocked by policy: ${policy.reason}` : "Live agent created a reviewable proposal from scoped evidence.", after: { type: proposal.type, policy: policy.decision, evidenceIds: proposal.evidenceIds }, sourceIds: proposal.evidenceIds });
    return proposal;
  }

  protected createRecoveryProposal(recoveryCase: RecoveryCase, modelRunId: string): Proposal {
    const customer = this.world.customers.find((item) => item.id === recoveryCase.customerId);
    const attempt = this.world.paymentAttempts.find((item) => item.obligationId === recoveryCase.obligationId);
    const signalIds = this.world.signals.filter((item) => item.caseId === recoveryCase.id).map((item) => item.id);
    const proposal: Proposal = { id: newId("proposal"), merchantId: this.world.merchant.id, caseId: recoveryCase.id, obligationId: recoveryCase.obligationId, type: "recovery_message", intendedOutcome: "Offer one clear, neutral way to complete the original purchase.", recipient: customer?.email || "customer", scope: `${customer?.displayName || "Customer"} · original purchase`, channel: "email", payload: { subject: "Your Northstar Office order is ready to complete", body: "Hi, your original order is still reserved. The earlier authorization did not complete, so we created one secure payment link for the outstanding amount. You can continue whenever convenient.", amountMinor: Math.max(0, (this.world.obligations.find((item) => item.id === recoveryCase.obligationId)?.amountDue || 0) - (this.world.obligations.find((item) => item.id === recoveryCase.obligationId)?.amountPaid || 0)), createPaymentLink: true, linkLabel: "Complete purchase" }, evidenceIds: [...signalIds, ...(attempt ? [attempt.id] : [])], uncertainty: attempt?.errorDescription || "The earlier payment attempt was not verified as successful.", explanation: "One confirmed purchase identity supports one neutral message and one link; no discount is proposed.", policy: evaluateProposal(this.world.policy, this.caseForPolicy(recoveryCase), contactPolicyInput(this.world, recoveryCase, { channel: "email", type: "recovery_message", externalAction: true }, this.clock)), requiresApproval: true, status: "pending", modelRunId, actionVersion: recoveryCase.version, createdAt: nowIso() };
    this.world.proposals.unshift(proposal);
    this.world.approvals.unshift({ id: newId("approval"), proposalId: proposal.id, requestedBy: "agent", decision: "pending", createdAt: nowIso() });
    return proposal;
  }

  protected createDocumentProposal(recoveryCase: RecoveryCase, modelRunId: string): Proposal {
    const customer = this.world.customers.find((item) => item.id === recoveryCase.customerId);
    const message = this.world.messages.find((item) => item.caseId === recoveryCase.id && item.direction === "inbound");
    const document = this.world.documents.find((item) => item.customerId === recoveryCase.customerId && item.obligationId === recoveryCase.obligationId && item.permission === "approved_customer_share");
    if (!document) throw new RepositoryError("NOT_FOUND", "No approved matching document is available.");
    const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
    const proposal: Proposal = { id: newId("proposal"), merchantId: this.world.merchant.id, caseId: recoveryCase.id, obligationId: recoveryCase.obligationId, type: "document_response", intendedOutcome: "Remove the missing-document blocker and let the customer release the invoice.", recipient: customer?.email || "customer", scope: `${customer?.displayName || "Customer"} · matched invoice`, channel: "email", payload: { subject: "Signed delivery confirmation for your Northstar Office invoice", body: "Hi, sharing the signed delivery confirmation matched to your invoice. Once your team has this, you can release the outstanding balance. Reply here if anything else is needed.", documentId: document.id, createPaymentLink: true, amountMinor: Math.max(0, (obligation?.amountDue || 0) - (obligation?.amountPaid || 0)), currency: obligation?.currency || this.world.merchant.defaultCurrency, linkLabel: "Pay invoice" }, evidenceIds: [ ...(message ? [message.id] : []), document.id ], uncertainty: "The document matches this customer and obligation; payment timing remains with City Interiors’ finance team.", explanation: "The latest inbound email requests a signed delivery confirmation. The matched document is permission-checked before sharing.", policy: evaluateProposal(this.world.policy, this.caseForPolicy(recoveryCase), contactPolicyInput(this.world, recoveryCase, { channel: "email", type: "document_response", externalAction: true }, this.clock)), requiresApproval: true, status: "pending", modelRunId, actionVersion: recoveryCase.version, createdAt: nowIso() };
    this.world.proposals.unshift(proposal);
    this.world.approvals.unshift({ id: newId("approval"), proposalId: proposal.id, requestedBy: "agent", decision: "pending", createdAt: nowIso() });
    return proposal;
  }

  async pauseCase(caseId: string, reason: string, pauseUntil?: string) {
    const recoveryCase = this.getCase(caseId);
    const before = summarizeCaseChange(recoveryCase);
    if (recoveryCase.state !== "paused") {
      try {
        const paused = transitionCase(recoveryCase, "paused");
        Object.assign(recoveryCase, paused);
      } catch (error) {
        this.addAudit({ actor: "system", eventType: "case.transition.rejected", entityType: "case", entityId: caseId, summary: "Illegal pause transition rejected without mutating case state.", before, after: { reason: error instanceof Error ? error.message : "unknown" }, sourceIds: [] });
        throw new RepositoryError("ILLEGAL_TRANSITION", "This case cannot be paused from its current state.");
      }
    } else recoveryCase.version += 1;
    recoveryCase.pauseReason = reason;
    recoveryCase.pauseUntil = pauseUntil;
    recoveryCase.nextAction = pauseUntil ? `Recheck after ${new Date(pauseUntil).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}` : "Resume only when a permitted next step is clear";
    recoveryCase.updatedAt = nowIso();
    this.cancelCaseJobs(caseId, reason);
    if (pauseUntil) {
      const idempotencyKey = `case:${caseId}:recheck:${pauseUntil}`;
      if (!this.world.jobs.some((job) => job.idempotencyKey === idempotencyKey)) this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "recheck_promise", idempotencyKey, status: "queued", caseId, runAfter: pauseUntil, attempts: 0 });
    }
    this.addAudit({ actor: "merchant", eventType: "case.paused", entityType: "case", entityId: caseId, summary: `${this.isDemoPayment() ? `${reason} · Demo simulation` : reason}`, before, after: summarizeCaseChange(recoveryCase), sourceIds: [] , demo: this.isDemoPayment() });
    return recoveryCase;
  }

  async resumeCase(caseId: string) {
    const recoveryCase = this.getCase(caseId);
    const before = summarizeCaseChange(recoveryCase);
    try {
      const resumed = transitionCase(recoveryCase, "investigating");
      Object.assign(recoveryCase, { ...resumed, pauseReason: undefined, pauseUntil: undefined, nextAction: "Recheck evidence before any customer-facing action", updatedAt: nowIso() });
    } catch {
      throw new RepositoryError("ILLEGAL_TRANSITION", "This case cannot be resumed from its current state.");
    }
    this.addAudit({ actor: "merchant", eventType: "case.resumed", entityType: "case", entityId: caseId, summary: "Case reopened for evidence-led investigation.", before, after: summarizeCaseChange(recoveryCase), sourceIds: [] });
    return recoveryCase;
  }

  protected async processFixtureBatch(batch: BatchRun, instructionRecord: InstructionRecord) {
    batch.status = "running";
    batch.startedAt = nowIso();
    const queue = batch.caseIds.slice();
    let cursor = 0;
    const runOne = async () => {
      while (cursor < queue.length) {
        const caseId = queue[cursor++];
        const job = this.world.jobs.find((item) => item.batchRunId === batch.id && item.caseId === caseId);
        if (job) await this.markJob(job.idempotencyKey, "running");
        try {
          await this.investigateCase(caseId);
          if (job) await this.markJob(job.idempotencyKey, "completed");
          await this.completeBatchCase(batch.id, caseId);
        } catch (error) {
          if (job) await this.markJob(job.idempotencyKey, "failed", error instanceof Error ? error.message : "Batch investigation failed");
          await this.completeBatchCase(batch.id, caseId, error instanceof Error ? error.message : "Batch investigation failed");
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(batch.concurrency, Math.max(1, queue.length)) }, () => runOne()));
    if (batch.status === "running") batch.status = batch.failedCaseIds.length > 0 && batch.completedCaseIds.length === 0 ? "failed" : "completed";
    batch.finishedAt = nowIso();
    instructionRecord.status = batch.status === "failed" ? "failed" : "completed";
    instructionRecord.completedAt = batch.finishedAt;
    this.addAudit({ actor: "system", eventType: "batch.completed", entityType: "batch_run", entityId: batch.id, summary: `Batch review completed with ${batch.completedCaseIds.length} successful and ${batch.failedCaseIds.length} failed case investigations.`, after: { status: batch.status, completedCaseIds: batch.completedCaseIds, failedCaseIds: batch.failedCaseIds }, sourceIds: batch.caseIds });
  }

  protected invokeRecoveryChat(input: ChatInvocationInput) {
    return runRecoveryChat(input);
  }

  protected async executeAgentChat(caseId: string | undefined, prompt: string, inputHash: string): Promise<AgentChatResponse> {
    const anchorCase = caseId ? this.getCase(caseId) : this.world.cases.find((item) => item.primary && item.state !== "closed") || this.world.cases.find((item) => item.state !== "closed") || this.world.cases[0];
    if (!anchorCase) throw new RepositoryError("NOT_FOUND", "No recovery case is available to anchor this agent run.");
    const selectedProvider = this.selectedAgentProvider();
    const snapshot = JSON.stringify(this.world);
    const runId = newId("run");
    const instructionRecord: InstructionRecord = { id: newId("instruction"), merchantId: this.world.merchant.id, caseId, instruction: prompt, intent: "case_review", status: "received", createdAt: nowIso() };
    this.world.instructions.unshift(instructionRecord);
    const run: AgentRun = { id: runId, merchantId: this.world.merchant.id, caseId: anchorCase.id, provider: selectedProvider, model: selectedProvider === "fixture" ? "scripted-fixture-recovery-chat-v1" : selectedProvider === "fireworks" ? runtimeConfig().fireworksModel : "codex-app-server", status: "running", stepCount: 0, toolCallSummaries: [], invocationReason: "explicit_chat", inputHash, startedAt: nowIso() };
    this.world.agentRuns.unshift(run);
    this.addAudit({ actor: "agent", eventType: "agent.chat.started", entityType: "agent_run", entityId: run.id, summary: `Started one bounded ${selectedProvider} chat run for the merchant workspace.`, after: { runId, provider: selectedProvider, selectedCaseId: caseId, anchorCaseId: anchorCase.id, inputHash }, sourceIds: [], provider: selectedProvider, invocationReason: "explicit_chat", inputHash });
    try {
      const result: AgentChatResult = await this.invokeRecoveryChat({ context: this.chatToolContext(run.id), prompt, selectedCaseId: caseId, anchorCaseId: anchorCase.id, inputHash, invocationReason: "explicit_chat" });
      const text = result.text.trim();
      if (!text) throw new Error("AGENT_EMPTY_RESPONSE:Configured agent returned no visible response.");
      run.status = "completed";
      run.model = result.model;
      run.stepCount = Math.min(5, Math.max(1, result.steps));
      run.toolCallSummaries = result.toolCallSummaries.slice(0, 5);
      run.usage = result.usage;
      run.finishedAt = nowIso();
      instructionRecord.status = "completed";
      instructionRecord.completedAt = run.finishedAt;
      const completedCase = caseId ? this.world.cases.find((item) => item.id === caseId) : undefined;
      instructionRecord.pauseUntil = completedCase?.pauseUntil;
      this.addAudit({ actor: "agent", eventType: "agent.chat.completed", entityType: "agent_run", entityId: run.id, summary: `${selectedProvider} returned a bounded workspace-grounded response; mutations remain deterministic and approval-gated.`, after: { runId, response: text.slice(0, 4000), provider: result.provider, selectedCaseId: caseId, toolCallSummaries: run.toolCallSummaries, stepCount: run.stepCount }, sourceIds: [], provider: result.provider, invocationReason: "explicit_chat", inputHash, usage: result.usage });
      return { case: caseId ? this.getCase(caseId) : undefined, message: text, agent: { runId, provider: result.provider, model: result.model, toolCallSummaries: run.toolCallSummaries, status: "completed" } };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown configured agent failure";
      this.world = JSON.parse(snapshot) as DemoWorld;
      const failedRun: AgentRun = { ...run, status: "failed", error: errorMessage, finishedAt: nowIso() };
      this.world.agentRuns.unshift(failedRun);
      this.addAudit({ actor: "agent", eventType: "agent.chat.failed", entityType: "agent_run", entityId: failedRun.id, summary: `The configured ${selectedProvider} chat provider failed. No canned operational response or state mutation was applied.`, after: { runId, provider: selectedProvider, error: errorMessage }, sourceIds: [], provider: selectedProvider, invocationReason: "explicit_chat", inputHash });
      if (error instanceof RepositoryError && error.code === "AGENT_PROVIDER_FAILED") throw error;
      throw new RepositoryError("AGENT_PROVIDER_FAILED", `The configured ${selectedProvider} agent failed. No canned response or state mutation was applied.`, { runId, provider: selectedProvider, error: errorMessage });
    }
  }

  protected async submitAgentChat(caseId: string | undefined, instruction: string): Promise<AgentChatResponse> {
    const inputHash = canonicalChatInputHash(this.world, instruction, caseId);
    const previousRun = this.world.agentRuns.find((run) => run.provider === this.selectedAgentProvider() && run.invocationReason === "explicit_chat" && run.inputHash === inputHash && run.status === "completed");
    if (previousRun) {
      const previousAudit = this.world.audit.find((event) => event.eventType === "agent.chat.completed" && event.entityId === previousRun.id);
      const response = typeof previousAudit?.after?.response === "string" ? previousAudit.after.response : undefined;
      if (response) return { case: caseId ? this.getCase(caseId) : undefined, message: response, agent: { runId: previousRun.id, provider: previousRun.provider, model: previousRun.model, toolCallSummaries: previousRun.toolCallSummaries, status: "deduplicated" } };
    }
    const inFlight = this.chatInFlight.get(inputHash);
    if (inFlight) return inFlight;
    const task = this.executeAgentChat(caseId, instruction, inputHash);
    this.chatInFlight.set(inputHash, task);
    try { return await task; } finally { if (this.chatInFlight.get(inputHash) === task) this.chatInFlight.delete(inputHash); }
  }

  async submitInstruction(caseId: string | undefined, instruction: string): Promise<{ case?: RecoveryCase; message: string; batchRun?: BatchRun; agent?: { runId: string; provider: AgentProvider; model: string; toolCallSummaries: string[]; status: "completed" | "deduplicated" } }> {
    const trimmed = instruction.trim();
    if (isGreeting(trimmed)) return { message: "Hi — I’m Rebound. Ask me about the current workspace or case, and I’ll use the configured agent within the visible guardrails." };
    const lower = trimmed.toLowerCase();
    const isBatch = isBatchReviewRequest(trimmed);
    if (isBatch) {
      const eligible = this.world.cases.filter((item) => {
        const obligation = this.world.obligations.find((candidate) => candidate.id === item.obligationId);
        return Boolean(obligation && !["cancelled", "review_required"].includes(obligation.status) && obligation.amountDue > obligation.amountPaid && item.state === "detected" && isOrdinaryChasingEligible(item, this.world.policy, this.clock()));
      });
      const instructionRecord: InstructionRecord = { id: newId("instruction"), merchantId: this.world.merchant.id, instruction, intent: "batch_review", status: "queued", createdAt: nowIso() };
      const batch: BatchRun = { id: newId("batch"), merchantId: this.world.merchant.id, instructionId: instructionRecord.id, instruction, status: "queued", concurrency: 2, caseIds: eligible.map((item) => item.id), completedCaseIds: [], failedCaseIds: [], startedAt: nowIso() };
      instructionRecord.batchRunId = batch.id;
      this.world.instructions.unshift(instructionRecord);
      this.world.batchRuns.unshift(batch);
      for (const recoveryCase of eligible) {
        const idempotencyKey = `batch:${batch.id}:case:${recoveryCase.id}`;
        if (!this.world.jobs.some((job) => job.idempotencyKey === idempotencyKey)) this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "investigate_case", idempotencyKey, status: "queued", caseId: recoveryCase.id, batchRunId: batch.id, attempts: 0 });
      }
      this.addAudit({ actor: "merchant", eventType: "instruction.persisted", entityType: "batch_run", entityId: batch.id, summary: "Merchant batch instruction persisted as independent, bounded case investigations.", after: { instructionId: instructionRecord.id, caseIds: batch.caseIds, concurrency: batch.concurrency }, sourceIds: batch.caseIds });
      if (this.fixtureAsync && this.selectedAgentProvider() === "fixture" && this.selectedEvidenceProvider() === "fixture") setTimeout(() => { void this.processFixtureBatch(batch, instructionRecord); }, 25);
      return { case: caseId ? this.getCase(caseId) : undefined, batchRun: batch, message: this.selectedAgentProvider() === "fixture" && this.selectedEvidenceProvider() === "fixture" ? `Batch review queued for ${batch.caseIds.length} eligible cases. The demo worker is retrieving evidence and preparing reviewable actions.` : `Batch review queued for ${batch.caseIds.length} eligible cases. The persistent worker will investigate them independently.` };
    }
    void lower;
    return this.submitAgentChat(caseId, trimmed);
  }

  async resolveIncident(incidentId: string) {
    const incident = this.world.incidents.find((item) => item.id === incidentId);
    if (!incident) throw new RepositoryError("NOT_FOUND", "Incident not found.");
    if (incident.status === "resolved") return { incident, eligibleCaseIds: [], excludedCaseIds: [] };
    incident.status = "resolved";
    incident.resolvedAt = nowIso();
    const eligibleCaseIds: string[] = [];
    const excludedCaseIds: string[] = [];
    for (const recoveryCase of this.world.cases.filter((item) => item.incidentId === incidentId)) {
      const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
      if (!obligation || isFullyPaid(obligation.amountDue, obligation.amountPaid) || recoveryCase.state === "recovered") {
        excludedCaseIds.push(recoveryCase.id);
        continue;
      }
      if (["dispute", "inability_to_pay", "opted_out"].includes(recoveryCase.blocker) || recoveryCase.blocker === "promise_to_pay") {
        excludedCaseIds.push(recoveryCase.id);
        continue;
      }
      if (recoveryCase.state === "paused") {
        const investigating = transitionCase(recoveryCase, "investigating");
        Object.assign(recoveryCase, { ...investigating, pauseReason: undefined, pauseUntil: undefined, nextAction: "Incident resolved; revalidate before resuming eligible recovery", updatedAt: nowIso() });
      }
      eligibleCaseIds.push(recoveryCase.id);
      this.world.jobs.push({ id: newId("job"), merchantId: this.world.merchant.id, kind: "revalidate_incident", idempotencyKey: `incident:${incidentId}:case:${recoveryCase.id}:resolved`, status: "queued", caseId: recoveryCase.id, attempts: 0 });
    }
    this.addAudit({ actor: "merchant", eventType: "incident.resolved", entityType: "incident", entityId: incidentId, summary: `${this.isDemoPayment() ? "Demo simulation resolved" : "Incident resolved"}; affected cases were revalidated before any outreach could resume.`, after: { eligibleCaseIds, excludedCaseIds }, sourceIds: incident.evidence, demo: this.isDemoPayment() });
    return { incident, eligibleCaseIds, excludedCaseIds };
  }

  async updatePolicy(input: Partial<Pick<Policy, "reviewFirst" | "allowedChannels" | "contactStartHour" | "contactEndHour" | "timezone" | "maxAttempts" | "minimumSpacingHours" | "discountsAllowed" | "incidentSuppression">>) {
    const before = { ...this.world.policy };
    Object.assign(this.world.policy, input, { version: this.world.policy.version + 1, updatedAt: nowIso() });
    this.addAudit({ actor: "merchant", eventType: "policy.updated", entityType: "policy", entityId: this.world.policy.id, summary: `Policy v${this.world.policy.version} saved.`, before: before as unknown as Record<string, unknown>, after: this.world.policy as unknown as Record<string, unknown>, sourceIds: [] });
    return this.world.policy;
  }

  async verifyFixturePayment(publicToken: string, amount?: number): Promise<PaymentOutcome> {
    if (!this.isDemoPayment()) throw new RepositoryError("LIVE_CREDENTIALS_REQUIRED", "Fixture payment simulation is disabled when PAYMENT_PROVIDER=razorpay_test.");
    const link = this.world.paymentLinks.find((item) => item.publicToken === publicToken);
    if (!link) throw new RepositoryError("NOT_FOUND", "Payment Link not found or revoked.");
    const recoveryCase = this.world.cases.find((item) => item.obligationId === link.obligationId);
    const obligation = this.world.obligations.find((item) => item.id === link.obligationId);
    if (!recoveryCase || !obligation) throw new RepositoryError("NOT_FOUND", "Payment Link is not attached to a valid obligation.");
    const existing = this.world.payments.find((item) => item.razorpayPaymentId === `pay_fixture_${publicToken}`);
    if (existing) {
      const ledger = this.world.ledger.find((entry) => entry.paymentId === existing.id);
      return { paymentId: existing.id, caseId: recoveryCase.id, verified: existing.verified, deduplicated: true, acceptedAmount: ledger?.amount || 0, remainingAmount: Math.max(0, obligation.amountDue - obligation.amountPaid), overpayment: 0, status: obligation.status === "paid" ? "paid" : "partial", demo: true };
    }
    if (!["created", "partially_paid"].includes(link.status)) throw new RepositoryError("INVALID_PAYMENT", "This Payment Link is no longer payable.");
    const paymentAmount = Math.max(0, amount ?? Math.max(0, obligation.amountDue - obligation.amountPaid));
    if (!paymentAmount) throw new RepositoryError("INVALID_PAYMENT", "There is no outstanding balance on this Link.");
    return this.applyVerifiedPayment({ link, recoveryCase, obligation, paymentId: `pay_fixture_${publicToken}`, paymentAmount, eventId: `fixture-event-${publicToken}` });
  }

  protected applyVerifiedPayment(input: { link: PaymentLink; recoveryCase: RecoveryCase; obligation: DemoWorld["obligations"][number]; paymentId: string; paymentAmount: number; eventId: string }): PaymentOutcome {
    const { link, recoveryCase, obligation, paymentId, paymentAmount, eventId } = input;
    const existingPayment = this.world.payments.find((item) => item.razorpayPaymentId === paymentId);
    if (existingPayment) {
      const ledger = this.world.ledger.find((entry) => entry.paymentId === existingPayment.id);
      this.addAudit({ actor: "connector", eventType: "payment.duplicate", entityType: "payment", entityId: existingPayment.id, summary: "Duplicate provider payment ignored; the existing verified collection and ledger entry were preserved.", sourceIds: [eventId] });
      return { paymentId: existingPayment.id, caseId: recoveryCase.id, verified: existingPayment.verified, deduplicated: true, acceptedAmount: ledger?.amount || 0, remainingAmount: Math.max(0, obligation.amountDue - obligation.amountPaid), overpayment: 0, status: isFullyPaid(obligation.amountDue, obligation.amountPaid) ? "paid" : "partial", demo: this.isDemoPayment() };
    }
    const balance = reconcilePayment(obligation.amountDue, obligation.amountPaid, paymentAmount);
    const payment: Payment = { id: newId("payment"), merchantId: this.world.merchant.id, obligationId: obligation.id, paymentLinkId: link.id, razorpayPaymentId: paymentId, amount: paymentAmount, verified: true, capturedAt: nowIso(), provider: this.isDemoPayment() ? "fixture" : "razorpay", webhookEventId: eventId, createdAt: nowIso() };
    this.world.payments.push(payment);
    link.amountPaid += balance.accepted;
    link.status = balance.status === "paid" ? "paid" : balance.status === "overpayment" ? "partially_paid" : "partially_paid";
    obligation.amountPaid += balance.accepted;
    obligation.status = balance.status === "paid" ? "paid" : balance.status === "overpayment" ? "review_required" : "partially_paid";
    this.addAudit({ actor: "connector", eventType: "payment.webhook.verified", entityType: "payment", entityId: payment.id, summary: `${this.isDemoPayment() ? "Fixture simulation: " : ""}authoritative ${this.isDemoPayment() ? "fixture " : "Razorpay "}payment event verified for ${formatMoney(balance.accepted, obligation.currency)}.`, after: { providerPaymentId: paymentId, eventId, acceptedAmount: balance.accepted, remainingAmount: balance.remaining, overpayment: balance.overpayment, provider: this.selectedPaymentProvider() }, sourceIds: [eventId], demo: this.isDemoPayment(), provider: this.selectedPaymentProvider() });
    if (balance.overpayment > 0) {
      if (recoveryCase.state !== "escalated") {
        try { Object.assign(recoveryCase, transitionCase(recoveryCase, "escalated")); } catch { /* preserve truth; review required */ }
      }
      recoveryCase.nextAction = "Review overpayment before reconciliation";
      recoveryCase.updatedAt = nowIso();
    } else if (balance.status === "paid") {
      const before = summarizeCaseChange(recoveryCase);
      if (recoveryCase.state !== "recovered") {
        try { Object.assign(recoveryCase, transitionCase(recoveryCase, "recovered")); } catch { /* an already terminal state remains truthful */ }
      }
      recoveryCase.nextAction = "No action — payment verified and ledger posted once";
      recoveryCase.updatedAt = nowIso();
      this.cancelCaseJobs(recoveryCase.id, "Payment verified");
      this.addAudit({ actor: "system", eventType: "case.recovered", entityType: "case", entityId: recoveryCase.id, summary: "Case marked recovered only after authoritative payment verification.", before, after: summarizeCaseChange(recoveryCase), sourceIds: [payment.id] });
    } else {
      recoveryCase.nextAction = `Reconcile remaining ${formatMoney(balance.remaining, obligation.currency)}; do not count this as full recovery`;
      recoveryCase.updatedAt = nowIso();
    }
    if (!this.world.ledger.some((entry) => entry.idempotencyKey === `ledger:${paymentId}`) && balance.accepted > 0) {
      const ledgerEntry: LedgerEntry = { id: newId("ledger"), merchantId: this.world.merchant.id, obligationId: obligation.id, paymentId: payment.id, amount: balance.accepted, currency: obligation.currency, idempotencyKey: `ledger:${paymentId}`, verifiedAt: nowIso() };
      this.world.ledger.unshift(ledgerEntry);
      this.addAudit({ actor: "system", eventType: "ledger.posted", entityType: "ledger", entityId: ledgerEntry.id, summary: `Verified collection posted once for ${formatMoney(ledgerEntry.amount, ledgerEntry.currency)}.`, after: { idempotencyKey: ledgerEntry.idempotencyKey }, sourceIds: [payment.id], demo: this.isDemoPayment(), provider: this.selectedPaymentProvider() });
    }
    return { paymentId: payment.id, caseId: recoveryCase.id, verified: true, deduplicated: false, acceptedAmount: balance.accepted, remainingAmount: balance.remaining, overpayment: balance.overpayment, status: balance.status, demo: this.isDemoPayment() };
  }

  async ingestRazorpayEvent(eventId: string, event: Record<string, unknown>, rawBody?: string) {
    const existingReceipt = this.world.webhookReceipts.find((receipt) => receipt.eventId === eventId);
    if (existingReceipt) {
      this.addAudit({ actor: "connector", eventType: "webhook.duplicate", entityType: "event", entityId: eventId, summary: "Duplicate Razorpay webhook ignored after its durable receipt was found.", after: { receiptStatus: existingReceipt.status }, sourceIds: [eventId] });
      return { duplicate: true };
    }
    const payload = (event.payload as Record<string, unknown> | undefined) || event;
    const payment = payload.payment as Record<string, unknown> | undefined;
    const paymentEntity = payment?.entity as Record<string, unknown> | undefined;
    const paymentLink = (payload.paymentLink || payload.payment_link) as Record<string, unknown> | undefined;
    const paymentLinkEntity = paymentLink?.entity as Record<string, unknown> | undefined;
    const eventName = String(event.event || payload.event || "").toLowerCase();
    const providerPaymentId = String(payload.paymentId || payload.payment_id || payment?.id || paymentEntity?.id || "");
    const paymentLinkId = String(payload.paymentLinkId || payload.payment_link_id || payment?.payment_link_id || paymentEntity?.payment_link_id || paymentLink?.id || paymentLinkEntity?.id || "");
    const link = this.world.paymentLinks.find((item) => item.razorpayLinkId === paymentLinkId || item.id === paymentLinkId);
    const raw = rawBody || JSON.stringify(event);
    const receipt: WebhookReceipt = { id: newId("webhook"), merchantId: this.world.merchant.id, eventId, rawBody: raw, payloadHash: createHash("sha256").update(raw).digest("hex"), eventType: eventName || undefined, providerPaymentId: providerPaymentId || undefined, providerLinkId: paymentLinkId || undefined, status: "received", receivedAt: nowIso() };
    this.world.webhookReceipts.unshift(receipt);
    const paymentStatus = String(paymentEntity?.status || payment?.status || payload.status || "").toLowerCase();
    const linkStatus = String(paymentLinkEntity?.status || paymentLink?.status || payload.linkStatus || "").toLowerCase();
    const currency = String(paymentEntity?.currency || payment?.currency || paymentLinkEntity?.currency || paymentLink?.currency || payload.currency || "").toUpperCase();
    const referenceId = String(paymentLinkEntity?.reference_id || paymentLinkEntity?.referenceId || paymentLink?.reference_id || payload.referenceId || payload.reference_id || paymentEntity?.order_id || "");
    const eventMerchantId = String(payload.merchantId || payload.merchant_id || paymentEntity?.merchant_id || "");
    const invalidReasons: string[] = [];
    if (eventMerchantId && eventMerchantId !== this.world.merchant.id) invalidReasons.push("merchant_mismatch");
    if (!providerPaymentId) invalidReasons.push("payment_id_missing");
    if (!paymentLinkId) invalidReasons.push("payment_link_id_missing");
    if (!link) invalidReasons.push("payment_link_unmatched");
    if (!referenceId) invalidReasons.push("reference_missing");
    else if (link && referenceId !== link.referenceId) invalidReasons.push("reference_mismatch");
    const obligationCurrency = link ? this.world.obligations.find((item) => item.id === link.obligationId)?.currency : undefined;
    if (!currency) invalidReasons.push("currency_missing");
    else if (obligationCurrency && currency !== obligationCurrency) invalidReasons.push("currency_mismatch");
    const failedOrAuthorized = eventName.includes("failed") || eventName.includes("authorized") || paymentStatus === "failed" || paymentStatus === "authorized";
    const validCaptured = !failedOrAuthorized && ((eventName === "payment.captured" && paymentStatus === "captured") || (eventName === "payment_link.paid" && linkStatus === "paid" && (!paymentStatus || paymentStatus === "captured")));
    if (!validCaptured) invalidReasons.push(failedOrAuthorized ? "non_captured_event" : "captured_status_not_allowed");
    if (invalidReasons.length > 0) {
      receipt.status = "review";
      const signalType = failedOrAuthorized && eventName.includes("failed") ? "payment_failed" : "payment_event_rejected";
      this.world.signals.push({ id: newId("signal"), merchantId: this.world.merchant.id, type: signalType, source: "razorpay", externalId: eventId, payload: { ...payload, reviewReasons: invalidReasons, eventType: eventName, paymentStatus, linkStatus }, occurredAt: nowIso(), correlationStatus: "pending_review", obligationId: link?.obligationId, caseId: link ? this.world.cases.find((item) => item.obligationId === link.obligationId)?.id : undefined });
      this.addAudit({ actor: "connector", eventType: "webhook.review_required", entityType: "webhook", entityId: receipt.id, summary: "Signed Razorpay webhook was recorded but did not meet the captured/paid verification contract; no ledger effect was applied.", after: { eventId, eventType: eventName, paymentStatus, linkStatus, invalidReasons, providerPaymentId, paymentLinkId }, sourceIds: [eventId] });
      return { duplicate: false };
    }
    const recoveryCase = this.world.cases.find((item) => item.obligationId === link!.obligationId);
    const obligation = this.world.obligations.find((item) => item.id === link!.obligationId);
    if (!recoveryCase || !obligation) throw new RepositoryError("NOT_FOUND", "Webhook payment link is not attached to a valid obligation.");
    const amount = Number(payload.amount || payment?.amount || paymentEntity?.amount || paymentLink?.amount || paymentLinkEntity?.amount || 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      receipt.status = "review";
      this.addAudit({ actor: "connector", eventType: "webhook.review_required", entityType: "webhook", entityId: receipt.id, summary: "Captured webhook amount was missing or invalid; no collection was posted.", after: { eventId, amount }, sourceIds: [eventId] });
      return { duplicate: false };
    }
    if (this.world.payments.some((paymentRecord) => paymentRecord.razorpayPaymentId === providerPaymentId)) {
      receipt.status = "duplicate";
      this.addAudit({ actor: "connector", eventType: "webhook.provider_duplicate", entityType: "webhook", entityId: receipt.id, summary: "Provider payment ID was already reconciled; this new event was recorded without a second ledger post.", after: { providerPaymentId }, sourceIds: [eventId] });
      return { duplicate: true };
    }
    this.world.signals.push({ id: newId("signal"), merchantId: this.world.merchant.id, type: "payment_captured", source: "razorpay", externalId: eventId, payload: { ...payload, eventType: eventName, providerPaymentId, paymentLinkId, amount, currency: currency || obligation.currency }, occurredAt: nowIso(), correlationStatus: "matched", obligationId: obligation.id, caseId: recoveryCase.id });
    const outcome = this.applyVerifiedPayment({ link: link!, recoveryCase, obligation, paymentId: providerPaymentId, paymentAmount: amount, eventId });
    receipt.status = "applied";
    receipt.appliedAt = nowIso();
    this.addAudit({ actor: "connector", eventType: "webhook.applied", entityType: "webhook", entityId: receipt.id, summary: `Captured Razorpay event ${eventId} applied to the canonical obligation.`, after: { providerPaymentId, paymentLinkId, amount, remainingAmount: outcome.remainingAmount, ledgerPosted: outcome.acceptedAmount > 0 }, sourceIds: [eventId] });
    return { duplicate: outcome.deduplicated, payment: outcome };
  }

  async audit(filter?: string) {
    const all = this.world.audit.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!filter) return all;
    const query = filter.toLowerCase();
    return all.filter((item) => `${item.summary} ${item.eventType} ${item.actor}`.toLowerCase().includes(query));
  }

  async jobs() { return this.world.jobs; }

  async markJob(idempotencyKey: string, status: JobRecord["status"], lastError?: string) {
    const job = this.world.jobs.find((item) => item.idempotencyKey === idempotencyKey);
    if (!job) return;
    job.status = status;
    if (status === "running") job.attempts += 1;
    job.lastError = lastError;
  }

  async completeBatchCase(batchRunId: string, caseId: string, error?: string) {
    const batch = this.world.batchRuns.find((item) => item.id === batchRunId);
    if (!batch) return;
    if (error) {
      if (!batch.failedCaseIds.includes(caseId)) batch.failedCaseIds.push(caseId);
    } else if (!batch.completedCaseIds.includes(caseId)) {
      batch.completedCaseIds.push(caseId);
    }
    const finished = batch.completedCaseIds.length + batch.failedCaseIds.length >= batch.caseIds.length;
    if (finished) {
      batch.status = batch.failedCaseIds.length > 0 && batch.completedCaseIds.length === 0 ? "failed" : "completed";
      batch.finishedAt = batch.finishedAt || nowIso();
      const instruction = this.world.instructions.find((item) => item.id === batch.instructionId);
      if (instruction) { instruction.status = batch.status === "failed" ? "failed" : "completed"; instruction.completedAt = batch.finishedAt; }
    } else if (batch.status === "queued") batch.status = "running";
  }

  async detectIncidents() {
    this.correlatePendingSignals();
    const cutoff = this.clock().getTime() - 24 * 60 * 60 * 1000;
    const groups = new Map<string, { method: string; instrument: string; attempts: DemoWorld["paymentAttempts"] }>();
    for (const attempt of this.world.paymentAttempts) {
      if (attempt.status !== "failed" || new Date(attempt.createdAt).getTime() < cutoff) continue;
      const method = attempt.method.trim().toLowerCase() || "unknown";
      const instrument = attempt.errorStep?.trim().toLowerCase() || "payment";
      const key = `${method}:${instrument}:${attempt.errorSource?.trim().toLowerCase() || "unknown"}`;
      const group = groups.get(key) || { method, instrument, attempts: [] };
      group.attempts.push(attempt);
      groups.set(key, group);
    }

    const detected: Incident[] = [];
    for (const group of groups.values()) {
      if (group.attempts.length < 3) continue;
      let downtime: { available: boolean; provider?: string; method?: string; source: "razorpay" | "fixture" } | undefined;
      try {
        downtime = await getRazorpayAdapter().fetchDowntime();
      } catch (error) {
        this.addAudit({ actor: "connector", eventType: "incident.confirmation.error", entityType: "incident", entityId: `incident-check:${group.method}:${group.instrument}`, summary: "Razorpay downtime confirmation could not be fetched; the failure cluster remains an inference.", after: { error: error instanceof Error ? error.message : "unknown", method: group.method, instrument: group.instrument }, sourceIds: group.attempts.map((attempt) => attempt.id) });
      }
      const existing = this.world.incidents.find((incident) => incident.status === "active" && incident.method.toLowerCase() === group.method && incident.instrument.toLowerCase() === group.instrument);
      const confirmation: Incident["confirmation"] = downtime?.available ? "confirmed" : this.isDemoPayment() ? "simulated" : "inferred";
      const provider = downtime?.provider || existing?.provider || "Razorpay";
      const method = downtime?.method || existing?.method || group.method;
      const instrument = existing?.instrument || group.instrument;
      const obligationIds = new Set(group.attempts.map((attempt) => attempt.obligationId));
      const members = this.world.cases.filter((recoveryCase) => obligationIds.has(recoveryCase.obligationId) || recoveryCase.incidentId === existing?.id);
      const memberIds = new Set(members.map((recoveryCase) => recoveryCase.id));
      const signalIds = this.world.signals.filter((signal) => signal.caseId && memberIds.has(signal.caseId)).map((signal) => signal.id);
      const evidence = [...new Set([...group.attempts.map((attempt) => attempt.id), ...signalIds])];
      const affectedValue = members.reduce((total, recoveryCase) => {
        const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
        return total + (obligation ? Math.max(0, obligation.amountDue - obligation.amountPaid) : 0);
      }, 0);
      const now = this.clock().toISOString();
      const summary = `${members.length} affected case${members.length === 1 ? "" : "s"} share ${provider} ${method} ${instrument} failures (${group.attempts.length} recent failed attempts; ${affectedValue} minor units outstanding). ${confirmation === "confirmed" ? "Razorpay downtime evidence confirms the incident." : confirmation === "simulated" ? "Fixture input is a demo simulation, not live provider confirmation." : "No provider downtime confirmation was available, so this remains an inferred pattern."}`;
      const incident: Incident = existing || {
        id: newId("incident"),
        merchantId: this.world.merchant.id,
        source: downtime?.available ? "razorpay" : "system",
        method,
        provider,
        instrument,
        severity: group.attempts.length >= 5 ? "high" : "medium",
        confirmation,
        status: "active",
        startedAt: group.attempts.map((attempt) => attempt.createdAt).sort()[0] || now,
        summary,
        evidence
      };
      const before = { confirmation: incident.confirmation, status: incident.status, evidence: incident.evidence, summary: incident.summary };
      const severity: Incident["severity"] = group.attempts.length >= 5 || existing?.severity === "high" ? "high" : "medium";
      Object.assign(incident, { source: downtime?.available ? "razorpay" : incident.source, method, provider, instrument, severity, confirmation, status: "active", evidence, summary });
      if (!existing) this.world.incidents.unshift(incident);

      for (const recoveryCase of members) {
        if (!recoveryCase.incidentId || this.isIncidentResolved(recoveryCase.incidentId)) recoveryCase.incidentId = incident.id;
        const obligation = this.world.obligations.find((item) => item.id === recoveryCase.obligationId);
        const stopped = ["dispute", "inability_to_pay", "opted_out", "promise_to_pay"].includes(recoveryCase.blocker);
        if (!obligation || isFullyPaid(obligation.amountDue, obligation.amountPaid) || recoveryCase.state === "recovered" || recoveryCase.state === "closed" || stopped) continue;
        if (recoveryCase.state !== "paused") {
          const paused = transitionCase(recoveryCase, "paused");
          Object.assign(recoveryCase, { ...paused, pauseReason: "Shared payment incident detected", nextAction: "Revalidate after the provider incident resolves", updatedAt: now });
          this.cancelCaseJobs(recoveryCase.id, "Suppressed while shared payment incident is active");
          this.addAudit({ actor: "system", eventType: "outreach.suppressed", entityType: "case", entityId: recoveryCase.id, summary: "Ordinary outreach paused because a shared payment-failure incident was detected.", after: { incidentId: incident.id, confirmation, reason: "incident_suppression" }, sourceIds: evidence, demo: this.isDemoPayment(), provider: this.selectedPaymentProvider() });
        }
      }
      if (!existing || before.confirmation !== incident.confirmation || JSON.stringify(before.evidence) !== JSON.stringify(incident.evidence) || before.summary !== incident.summary) {
        this.addAudit({ actor: "system", eventType: existing ? "incident.updated" : "incident.detected", entityType: "incident", entityId: incident.id, summary: existing ? "Incident evidence and provider confirmation were refreshed from the failure cluster." : "A shared payment-failure incident was detected from a bounded recent cluster.", before, after: { confirmation: incident.confirmation, provider: incident.provider, method: incident.method, instrument: incident.instrument, affectedCases: members.length, affectedValue, evidence: incident.evidence }, sourceIds: incident.evidence, demo: this.isDemoPayment(), provider: this.selectedPaymentProvider() });
      }
      detected.push(incident);
    }
    return detected;
  }

  async reconcileSignals() {
    this.correlatePendingSignals();
  }

  async syncCaseEvidence(caseId: string) {
    const recoveryCase = this.getCase(caseId);
    this.correlatePendingSignals();
    await this.syncConnectorEvidence(recoveryCase);
  }

  async resetDemo() {
    const workspaceId = this.world.workspaceId || this.world.merchant.workspaceId || this.world.merchant.id;
    const fresh = createDemoWorld(workspaceId, this.world.capabilities || capabilityStatus());
    fresh.audit.unshift({ id: newId("audit"), merchantId: fresh.merchant.id, actor: "merchant", eventType: "demo.reset", entityType: "workspace", entityId: workspaceId, summary: "Fresh demo workspace restored; prior demo activity was replaced by the canonical starting state.", after: { workspaceId, providerModes: fresh.capabilities }, sourceIds: [], demo: true, createdAt: nowIso() });
    this.world = fresh;
  }
}

declare global {
  /** Connection reuse only; tenant/domain state never lives in this cache. */
  var __recoveryPostgresClients: Map<string, ReturnType<typeof postgres>> | undefined;
}

function postgresClients() {
  if (!globalThis.__recoveryPostgresClients) globalThis.__recoveryPostgresClients = new Map<string, ReturnType<typeof postgres>>();
  return globalThis.__recoveryPostgresClients;
}

function postgresClient(databaseUrl: string) {
  const clients = postgresClients();
  const existing = clients.get(databaseUrl);
  if (existing) return existing;
  const client = postgres(databaseUrl, { max: 3, idle_timeout: 20 });
  clients.set(databaseUrl, client);
  return client;
}

export class PostgresRepository implements RecoveryRepository {
  private client: ReturnType<typeof postgres>;
  private db: ReturnType<typeof drizzle>;

  constructor(private readonly databaseUrl: string, private readonly options: RepositoryOptions = {}) {
    this.client = postgresClient(databaseUrl);
    this.db = drizzle(this.client);
  }

  private async run<T>(fn: (repo: MemoryRepository) => Promise<T>, options: { persist?: boolean } = {}) {
    const persist = options.persist ?? true;
    let result!: T;
    await this.client.begin(async (tx) => {
      const publicToken = this.options.publicToken;
      const requestedWorkspaceId = this.options.workspaceId;
      const lookupRows = requestedWorkspaceId
        ? await tx`select workspace_id, payload from recovery_state where workspace_id = ${requestedWorkspaceId} limit 1` as Array<{ workspace_id: string; payload: DemoWorld }>
        : this.options.merchantId
          ? await tx`select workspace_id, payload from recovery_state where merchant_id = ${this.options.merchantId} limit 1` as Array<{ workspace_id: string; payload: DemoWorld }>
        : publicToken
          ? await tx`select workspace_id, payload from recovery_state where payload->'paymentLinks' @> ${JSON.stringify([{ publicToken }])}::jsonb limit 1` as Array<{ workspace_id: string; payload: DemoWorld }>
          : [];
      const workspaceId = requestedWorkspaceId || lookupRows[0]?.workspace_id;
      if (!workspaceId && publicToken) {
        // Unknown customer links must be a read-only miss. Do not create a
        // fresh tenant or persist anything merely because a public URL was
        // mistyped.
        const empty = new MemoryRepository(createDemoWorld(), undefined, { fixtureAsync: false });
        result = await fn(empty);
        return;
      }
      if (!workspaceId) throw new RepositoryError("WORKSPACE_REQUIRED", "A signed demo workspace is required for merchant operations.");

      // Mutations take a tenant-scoped lock. A missing snapshot is the one
      // read-time exception: first-visit initialization must be atomic and
      // idempotent, but an existing read never rewrites normalized state.
      const needsInitialization = lookupRows.length === 0;
      if (persist || needsInitialization) await tx`select pg_advisory_xact_lock(hashtextextended(${workspaceId}, 481927))`;
      const rows = await tx`select payload from recovery_state where workspace_id = ${workspaceId} limit 1` as Array<{ payload: DemoWorld }>;
      const stored = rows[0]?.payload;
      const config = runtimeConfig();
      if (stored) {
        const storedProviders = stored.merchant || {};
        const mismatch = [
          ["agent", storedProviders.agentProvider, config.agentProvider],
          ["evidence", storedProviders.evidenceProvider, config.evidenceProvider],
          ["payment", storedProviders.paymentProvider, config.paymentProvider]
        ].find(([, saved, selected]) => saved && saved !== selected);
        if (mismatch) throw new RepositoryError("PROVIDER_MISMATCH", `Workspace provider ${mismatch[0]}=${mismatch[1]} does not match the selected runtime provider ${mismatch[2]}. Refusing to silently switch modes.`);
      }
      const repo = new MemoryRepository(stored || createDemoWorld(workspaceId, capabilityStatus()), undefined, { fixtureAsync: false });
      result = await fn(repo);
      if (persist || !stored) {
        await replaceNormalizedWorld(tx, repo.world);
        await tx`
          insert into recovery_state (workspace_id, merchant_id, payload, updated_at)
          values (${workspaceId}, ${repo.world.merchant.id}, ${JSON.stringify(repo.world)}::jsonb, now())
          on conflict (workspace_id) do update set merchant_id = excluded.merchant_id, payload = excluded.payload, updated_at = now()
        `;
      }
    });
    return result;
  }

  async bootstrap() { return this.run((repo) => repo.bootstrap(), { persist: false }); }
  async getCaseView(caseId: string) { return this.run((repo) => repo.getCaseView(caseId), { persist: false }); }
  async getCustomerPage(token: string) { return this.run((repo) => repo.getCustomerPage(token), { persist: false }); }
  async decideProposal(input: DecideProposalInput) { return this.run((repo) => repo.decideProposal(input)); }
  async investigateCase(caseId: string, invocationReason?: AgentInvocationReason) { return this.run((repo) => repo.investigateCase(caseId, invocationReason)); }
  async pauseCase(caseId: string, reason: string, pauseUntil?: string) { return this.run((repo) => repo.pauseCase(caseId, reason, pauseUntil)); }
  async resumeCase(caseId: string) { return this.run((repo) => repo.resumeCase(caseId)); }
  async submitInstruction(caseId: string | undefined, instruction: string) { return this.run((repo) => repo.submitInstruction(caseId, instruction), { persist: instructionWrites(caseId, instruction) }); }
  async resolveIncident(incidentId: string) { return this.run((repo) => repo.resolveIncident(incidentId)); }
  async updatePolicy(input: Partial<Pick<Policy, "reviewFirst" | "allowedChannels" | "contactStartHour" | "contactEndHour" | "timezone" | "maxAttempts" | "minimumSpacingHours" | "discountsAllowed" | "incidentSuppression">>) { return this.run((repo) => repo.updatePolicy(input)); }
  async verifyFixturePayment(token: string, amount?: number) { return this.run((repo) => repo.verifyFixturePayment(token, amount)); }
  async ingestRazorpayEvent(eventId: string, event: Record<string, unknown>, rawBody?: string) { return this.run((repo) => repo.ingestRazorpayEvent(eventId, event, rawBody)); }
  async audit(filter?: string) { return this.run((repo) => repo.audit(filter), { persist: false }); }
  async jobs() {
    if (!this.options.workspaceId && !this.options.publicToken) {
      const rows = await this.client`select payload from recovery_state` as Array<{ payload: DemoWorld }>;
      return rows.flatMap((row) => Array.isArray(row.payload?.jobs) ? row.payload.jobs : []) as JobRecord[];
    }
    return this.run((repo) => repo.jobs(), { persist: false });
  }
  async markJob(idempotencyKey: string, status: JobRecord["status"], lastError?: string) { return this.run((repo) => repo.markJob(idempotencyKey, status, lastError)); }
  async completeBatchCase(batchRunId: string, caseId: string, error?: string) { return this.run((repo) => repo.completeBatchCase(batchRunId, caseId, error)); }
  async reconcileSignals() { return this.run((repo) => repo.reconcileSignals()); }
  async detectIncidents() { return this.run((repo) => repo.detectIncidents()); }
  async syncCaseEvidence(caseId: string) { return this.run((repo) => repo.syncCaseEvidence(caseId)); }
  async resetDemo() { return this.run((repo) => repo.resetDemo()); }
}

declare global {
  var __recoveryMemoryRepositories: Map<string, MemoryRepository> | undefined;
}

function memoryRepositories() {
  if (!globalThis.__recoveryMemoryRepositories) globalThis.__recoveryMemoryRepositories = new Map<string, MemoryRepository>();
  return globalThis.__recoveryMemoryRepositories;
}

export function getRepository(options: RepositoryOptions = {}): RecoveryRepository {
  const config = runtimeConfig();
  if (config.databaseUrl) return new PostgresRepository(config.databaseUrl, options);
  if (config.mode !== "fixture") throw new RepositoryError("DATABASE_REQUIRED", "A non-fixture provider requires DATABASE_URL; fixture behavior is not used as a fallback.");
  const repositories = memoryRepositories();
  const existingByMerchant = options.merchantId ? [...repositories.values()].find((item) => item.world.merchant.id === options.merchantId) : undefined;
  if (existingByMerchant) return existingByMerchant;
  if (options.merchantId) throw new RepositoryError("WORKSPACE_REQUIRED", "No local demo workspace owns this merchant scope.");
  const workspaceId = options.workspaceId || "00000000-0000-4000-8000-000000000000";
  let repository = repositories.get(workspaceId);
  if (!repository) {
    repository = new MemoryRepository(createDemoWorld(workspaceId, capabilityStatus()), undefined, { fixtureAsync: true });
    repositories.set(workspaceId, repository);
  }
  return repository;
}

function webhookReferences(event: Record<string, unknown>) {
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const paymentEnvelope = (payload.payment && typeof payload.payment === "object" ? payload.payment : {}) as Record<string, unknown>;
  const payment = (paymentEnvelope.entity && typeof paymentEnvelope.entity === "object" ? paymentEnvelope.entity : paymentEnvelope) as Record<string, unknown>;
  const linkEnvelope = (payload.payment_link && typeof payload.payment_link === "object" ? payload.payment_link : {}) as Record<string, unknown>;
  const link = (linkEnvelope.entity && typeof linkEnvelope.entity === "object" ? linkEnvelope.entity : linkEnvelope) as Record<string, unknown>;
  return {
    providerPaymentId: String(payment.id || payment.payment_id || event.providerPaymentId || event.payment_id || ""),
    providerLinkId: String(link.id || link.payment_link_id || payment.payment_link_id || event.providerLinkId || event.payment_link_id || "")
  };
}

export async function getRepositoryForWebhookEvent(event: Record<string, unknown>): Promise<RecoveryRepository | undefined> {
  const config = runtimeConfig();
  const { providerPaymentId, providerLinkId } = webhookReferences(event);
  if (config.databaseUrl) {
    const client = postgres(config.databaseUrl, { max: 1, idle_timeout: 10 });
    try {
      const rows = await client`
        select workspace_id
        from recovery_state
        where (${providerPaymentId || null} is not null and exists (
          select 1 from jsonb_array_elements(payload->'payments') item where item->>'razorpayPaymentId' = ${providerPaymentId}
        ))
           or (${providerLinkId || null} is not null and exists (
          select 1 from jsonb_array_elements(payload->'paymentLinks') item where item->>'razorpayLinkId' = ${providerLinkId}
        ))
        limit 1
      ` as Array<{ workspace_id: string }>;
      return rows[0]?.workspace_id ? new PostgresRepository(config.databaseUrl, { workspaceId: rows[0].workspace_id }) : undefined;
    } finally {
      await client.end({ timeout: 2 });
    }
  }
  for (const repository of memoryRepositories().values()) {
    if (!(repository instanceof MemoryRepository)) continue;
    const matches = repository.world.payments.some((payment) => providerPaymentId && payment.razorpayPaymentId === providerPaymentId) || repository.world.paymentLinks.some((link) => providerLinkId && link.razorpayLinkId === providerLinkId);
    if (matches) return repository;
  }
  return undefined;
}

export async function getRepositoryForPublicToken(publicToken: string): Promise<RecoveryRepository | undefined> {
  const config = runtimeConfig();
  if (config.databaseUrl) return new PostgresRepository(config.databaseUrl, { publicToken });
  if (config.mode !== "fixture") throw new RepositoryError("DATABASE_REQUIRED", "A non-fixture provider requires DATABASE_URL; fixture behavior is not used as a fallback.");
  for (const repository of memoryRepositories().values()) {
    if (await repository.getCustomerPage(publicToken)) return repository;
  }
  return undefined;
}

export function verifyWebhookSignature(rawBody: string, signature: string | null, secret: string) {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
  const received = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return received.length === expectedBuffer.length && timingSafeEqual(received, expectedBuffer);
}

export function resetMemoryRepositoryForTests() {
  const repositories = new Map<string, MemoryRepository>();
  const repository = new MemoryRepository(createDemoWorld(), undefined, { fixtureAsync: false });
  repositories.set("00000000-0000-4000-8000-000000000000", repository);
  globalThis.__recoveryMemoryRepositories = repositories;
  return repository;
}
