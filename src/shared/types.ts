import type { CASE_STATES, WORKFLOW_TYPES, BLOCKER_CATEGORIES } from "./constants";

export type CaseState = (typeof CASE_STATES)[number];
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];
export type BlockerCategory = (typeof BLOCKER_CATEGORIES)[number];
export type AppMode = "fixture" | "live";
export type AgentProvider = "fixture" | "fireworks" | "codex_app_server";
export type EvidenceProvider = "fixture" | "google" | "composio";
export type PaymentProvider = "fixture" | "razorpay_test";
export type StorageProvider = "memory" | "postgres";
export type ProviderMode = "fixture" | "test" | "live" | "google" | "composio" | "codex_app_server";
export type AgentInvocationReason = "explicit_investigation" | "new_evidence" | "changed_circumstance" | "approved_workflow";

export type ActorType = "system" | "agent" | "merchant" | "customer" | "connector";

export interface Merchant {
  id: string;
  name: string;
  mode: AppMode;
  demo?: boolean;
  workspaceId?: string;
  agentProvider?: AgentProvider;
  evidenceProvider?: EvidenceProvider;
  paymentProvider?: PaymentProvider;
  storageProvider?: StorageProvider;
  timezone: string;
  defaultCurrency: string;
}

export interface Customer {
  id: string;
  type: "individual" | "business";
  displayName: string;
  email: string;
  company?: string;
}

export interface Obligation {
  id: string;
  customerId: string;
  kind: "purchase" | "invoice";
  amountDue: number;
  amountPaid: number;
  currency: string;
  orderRef?: string;
  cartRef?: string;
  invoiceRef?: string;
  status: "open" | "partially_paid" | "paid" | "cancelled" | "review_required";
  dueAt?: string;
}

export interface RecoveryCase {
  id: string;
  merchantId: string;
  customerId: string;
  obligationId: string;
  workflow: WorkflowType;
  state: CaseState;
  priority: "low" | "medium" | "high";
  blocker: BlockerCategory;
  confidence: number;
  reason: string;
  nextAction: string;
  pauseReason?: string;
  pauseUntil?: string;
  incidentId?: string;
  lastAgentInputHash?: string;
  lastAgentRunId?: string;
  version: number;
  updatedAt: string;
  createdAt: string;
  primary?: boolean;
}

export interface Signal {
  id: string;
  merchantId: string;
  type: "payment_failed" | "checkout_abandoned" | "email_received" | "payment_captured" | "payment_event_rejected" | "incident_pattern";
  source: "razorpay" | "storefront" | "email" | "system";
  externalId: string;
  payload: Record<string, unknown>;
  occurredAt: string;
  correlationStatus: "matched" | "pending_review" | "merged";
  obligationId?: string;
  caseId?: string;
}

export interface PaymentAttempt {
  id: string;
  merchantId: string;
  obligationId: string;
  razorpayPaymentId: string;
  amount: number;
  method: string;
  status: "failed" | "authorized" | "captured";
  errorCode?: string;
  errorDescription?: string;
  errorSource?: string;
  errorStep?: string;
  createdAt: string;
}

export interface PaymentLink {
  id: string;
  merchantId: string;
  obligationId: string;
  razorpayLinkId: string;
  referenceId: string;
  amount: number;
  amountPaid: number;
  status: "created" | "partially_paid" | "paid" | "cancelled" | "expired";
  url: string;
  publicToken: string;
  acceptPartial: boolean;
  expiresAt?: string;
  createdAt: string;
}

export interface Payment {
  id: string;
  merchantId: string;
  obligationId: string;
  paymentLinkId?: string;
  razorpayPaymentId: string;
  amount: number;
  verified: boolean;
  capturedAt?: string;
  provider: "razorpay" | "fixture";
  webhookEventId?: string;
  createdAt: string;
}

export interface Invoice {
  id: string;
  merchantId: string;
  obligationId: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  documentId?: string;
}

export interface Message {
  id: string;
  merchantId: string;
  caseId?: string;
  obligationId?: string;
  direction: "inbound" | "outbound";
  channel: "email";
  providerId: string;
  threadId?: string;
  subject: string;
  body: string;
  participants: string[];
  from?: string;
  to?: string[];
  providerMode?: ProviderMode;
  providerUrl?: string;
  sentAt?: string;
  receivedAt?: string;
}

export interface DocumentRecord {
  id: string;
  merchantId: string;
  customerId?: string;
  obligationId?: string;
  providerId: string;
  name: string;
  mimeType: string;
  extractedText: string;
  sourceUrl: string;
  checksum: string;
  permission: "merchant_only" | "approved_customer_share";
  providerMode?: ProviderMode;
  matchReason?: string;
}

export interface Incident {
  id: string;
  merchantId: string;
  source: "razorpay" | "system";
  method: string;
  provider: string;
  instrument: string;
  severity: "low" | "medium" | "high";
  confirmation: "confirmed" | "inferred" | "simulated";
  status: "active" | "resolved";
  startedAt: string;
  resolvedAt?: string;
  summary: string;
  evidence: string[];
}

export interface ProposalPolicyResult {
  decision: "allowed" | "approval_required" | "blocked";
  reason: string;
  rules: string[];
}

export type ProposalType =
  | "recovery_message"
  | "document_response"
  | "signal_merge"
  | "pause_or_resume"
  | "promise_schedule"
  | "escalation";

export interface Proposal {
  id: string;
  merchantId: string;
  caseId: string;
  obligationId: string;
  type: ProposalType;
  intendedOutcome: string;
  recipient: string;
  scope: string;
  channel: "email" | "system";
  payload: Record<string, unknown>;
  evidenceIds: string[];
  uncertainty: string;
  explanation: string;
  policy: ProposalPolicyResult;
  requiresApproval: boolean;
  status: "pending" | "approved" | "rejected" | "executed" | "stale" | "blocked";
  modelRunId?: string;
  actionVersion: number;
  createdAt: string;
  decidedAt?: string;
}

export interface WebhookReceipt {
  id: string;
  merchantId: string;
  eventId: string;
  rawBody: string;
  payloadHash: string;
  eventType?: string;
  providerPaymentId?: string;
  providerLinkId?: string;
  status: "received" | "applied" | "review" | "duplicate";
  receivedAt: string;
  appliedAt?: string;
}

export interface InstructionRecord {
  id: string;
  merchantId: string;
  caseId?: string;
  instruction: string;
  intent: "batch_review" | "pause_contact" | "case_review" | "unknown";
  status: "received" | "queued" | "completed" | "failed";
  pauseUntil?: string;
  batchRunId?: string;
  createdAt: string;
  completedAt?: string;
  error?: string;
}

export interface BatchRun {
  id: string;
  merchantId: string;
  instructionId: string;
  instruction: string;
  status: "queued" | "running" | "completed" | "failed";
  concurrency: number;
  caseIds: string[];
  completedCaseIds: string[];
  failedCaseIds: string[];
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export interface Approval {
  id: string;
  proposalId: string;
  requestedBy: "agent" | "system";
  decidedBy?: "merchant";
  decision: "pending" | "approved" | "rejected";
  editedPayload?: Record<string, unknown>;
  rationale?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface Policy {
  id: string;
  merchantId: string;
  version: number;
  reviewFirst: boolean;
  allowedChannels: Array<"email">;
  contactStartHour: number;
  contactEndHour: number;
  timezone: string;
  maxAttempts: number;
  minimumSpacingHours: number;
  discountsAllowed: boolean;
  autoSendClasses: string[];
  incidentSuppression: boolean;
  updatedAt: string;
}

export interface JobRecord {
  id: string;
  merchantId: string;
  kind:
    | "ingest_signal"
    | "investigate_case"
    | "execute_proposal"
    | "send_email"
    | "payment_link"
    | "recheck_promise"
    | "detect_incident"
    | "revalidate_incident"
    | "connector_sync"
    | "retry_integration";
  idempotencyKey: string;
  status: "queued" | "running" | "completed" | "cancelled" | "failed";
  caseId?: string;
  proposalId?: string;
  batchRunId?: string;
  runAfter?: string;
  attempts: number;
  lastError?: string;
}

export interface LedgerEntry {
  id: string;
  merchantId: string;
  obligationId: string;
  paymentId: string;
  amount: number;
  currency: string;
  idempotencyKey: string;
  verifiedAt: string;
}

export interface AuditEvent {
  id: string;
  merchantId: string;
  actor: ActorType;
  eventType: string;
  entityType: string;
  entityId: string;
  summary: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  sourceIds: string[];
  createdAt: string;
  demo?: boolean;
  provider?: string;
  invocationReason?: AgentInvocationReason;
  inputHash?: string;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

export interface AgentRun {
  id: string;
  merchantId: string;
  caseId: string;
  provider: AgentProvider;
  model: string;
  status: "running" | "completed" | "failed" | "escalated";
  stepCount: number;
  toolCallSummaries: string[];
  error?: string;
  invocationReason?: AgentInvocationReason;
  inputHash?: string;
  skipped?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  startedAt: string;
  finishedAt?: string;
}

export interface ConnectorAccount {
  id: string;
  merchantId: string;
  type: "razorpay" | "email" | "drive";
  mode: ProviderMode;
  status: "healthy" | "fixture" | "not_configured" | "error";
  scopes: string[];
  encryptedTokenRef?: string;
  lastSyncAt?: string;
}

export interface RuntimeCapability {
  provider: string;
  status: "ready" | "fixture" | "not_configured" | "unsupported" | "error";
  label: string;
  model?: string;
  detail?: string;
}

export interface RuntimeCapabilities {
  agent: RuntimeCapability;
  evidence: RuntimeCapability;
  payment: RuntimeCapability;
  storage: RuntimeCapability;
}

export interface DemoWorld {
  workspaceId?: string;
  capabilities?: RuntimeCapabilities;
  merchant: Merchant;
  customers: Customer[];
  obligations: Obligation[];
  cases: RecoveryCase[];
  signals: Signal[];
  paymentAttempts: PaymentAttempt[];
  paymentLinks: PaymentLink[];
  payments: Payment[];
  invoices: Invoice[];
  messages: Message[];
  documents: DocumentRecord[];
  incidents: Incident[];
  proposals: Proposal[];
  approvals: Approval[];
  policy: Policy;
  jobs: JobRecord[];
  ledger: LedgerEntry[];
  audit: AuditEvent[];
  agentRuns: AgentRun[];
  connectors: ConnectorAccount[];
  webhookReceipts: WebhookReceipt[];
  instructions: InstructionRecord[];
  batchRuns: BatchRun[];
}

export interface CaseView extends RecoveryCase {
  customer: Customer;
  obligation: Obligation;
  signals: Signal[];
  paymentAttempt?: PaymentAttempt;
  paymentLink?: PaymentLink;
  invoice?: Invoice;
  messages: Message[];
  documents: DocumentRecord[];
  proposals: Proposal[];
  latestAudit: AuditEvent[];
  incident?: Incident;
}

export interface BootstrapPayload {
  productName: string;
  merchant: Merchant;
  mode: AppMode;
  summary: { outstanding: number; verifiedRecovered: number; currency: string };
  cases: CaseView[];
  incidents: Incident[];
  proposals: Proposal[];
  approvals: Approval[];
  policy: Policy;
  connectors: ConnectorAccount[];
  audit: AuditEvent[];
  ledger: LedgerEntry[];
  jobs: JobRecord[];
  orb: { state: "idle" | "inspecting" | "working" | "approval" | "paused" | "success" | "uncertain" | "error"; label: string; caseId?: string; updatedAt: string };
  batchRuns: BatchRun[];
  evaluation?: EvaluationReport;
  integrationProof: IntegrationProof;
  capabilities: RuntimeCapabilities;
}

export interface CustomerPageData {
  merchant: Merchant;
  customer: Customer;
  obligation: Obligation;
  case: RecoveryCase;
  paymentLink: PaymentLink;
  document?: DocumentRecord;
  message?: Message;
  demo: boolean;
}

export interface EvaluationCaseResult {
  caseId: string;
  label: string;
  blockerExpected: BlockerCategory | "ambiguous" | "insufficient_evidence";
  blockerActual: string;
  interventionExpected: string;
  interventionActual: string;
  documentExpected?: string;
  documentActual?: string;
  contactEligibleExpected: boolean;
  contactEligibleActual: boolean;
  resolvable: boolean;
  status: "correct" | "unresolved" | "error" | "incorrect";
  reason?: string;
  startingOutstanding: number;
  remainingValue: number;
}

export interface EvaluationMetrics {
  totalCases: number;
  startingOutstanding: number;
  remainingValue: number;
  blockerClassification: { correct: number; denominator: number };
  interventionAccuracy: { correct: number; denominator: number };
  documentMatches: { correct: number; denominator: number };
  suppressionsEscalations: { correct: number; denominator: number };
  unnecessaryContactsAvoided: { correct: number; denominator: number };
  unresolvedOrErrors: { count: number; denominator: number };
}

export interface EvaluationReport {
  runId: string;
  datasetVersion: string;
  buildId: string;
  mode: AppMode;
  provider: AgentProvider;
  startedAt: string;
  finishedAt: string;
  metrics: EvaluationMetrics;
  results: EvaluationCaseResult[];
  integrationProof: IntegrationProof;
  baseline?: { name: string; unnecessaryContacts: number; denominator: number };
}

export interface IntegrationProof {
  mode: AppMode;
  capabilities?: RuntimeCapabilities;
  connectorRetrievedMessages: number;
  connectorRetrievedDocuments: number;
  providerSentEmails: number;
  razorpayCreatedLinks: number;
  signedRazorpayPayments: number;
  verifiedCollectedAmount: number;
  apiConfirmed: boolean;
}
