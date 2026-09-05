import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fireworks } from "@ai-sdk/fireworks";
import { ToolLoopAgent, stepCountIs } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { AgentInvocationReason, AgentProvider, Proposal } from "@/shared/types";
import type { RecoveryChatToolContext, RecoveryToolContext } from "@/server/agent/tools";
import { recoveryChatTools, recoveryTools } from "@/server/agent/tools";
import { assertAgentCredentials, FIREWORKS_MODEL, runtimeConfig } from "@/server/config";
import { proposalSchema } from "@/server/agent/schemas";

export const RECOVERY_AGENT_INSTRUCTIONS = `You are a cautious financial-operations coworker for ${process.env.PRODUCT_NAME || "Rebound"}. Distinguish evidence from inference, prefer the least aggressive effective intervention, obey the merchant policy and strict tool schemas, and stop when evidence is insufficient. You may read scoped evidence and create reviewable proposals only. Never send a message, create/cancel a payment link, mutate payment state, post a ledger entry, or claim a payment succeeded. Only an authoritative verified Razorpay event can record recovery. Keep explanations concise and cite visible evidence IDs. Never reveal hidden reasoning or connector secrets.`;

export const RECOVERY_CHAT_AGENT_INSTRUCTIONS = `You are Rebound, a cautious financial-operations coworker. This is a live conversational turn for a merchant workspace. Answer the merchant's actual request using the tenant-scoped workspace snapshot and bounded tools; do not guess, invent current state, or return a canned workspace summary. For workspace or case questions, use the read-only tools that are relevant to the request and cite visible customer names, states, evidence, policy or audit facts. For "investigate", use the bounded investigate_case operation. For pause/resume, use the corresponding deterministic operation for the exact case and report its result. For any customer-facing or monetary action, create a reviewable proposal instead of executing it; approval remains mandatory. Never send email, create or activate a payment link, mark money recovered, post a ledger entry, bypass policy, or claim payment success. Distinguish Demo/Fixture evidence from live provider evidence. Keep the response concise, state uncertainty plainly, and stop within the tool limit.`;

export interface AgentInvocationInput {
  context: RecoveryToolContext;
  workflow: "failed_purchase" | "invoice_resolution" | "shared_incident";
  prompt: string;
  caseId: string;
  inputHash: string;
  invocationReason: AgentInvocationReason;
}

export interface AgentInvocationResult {
  provider: AgentProvider;
  model: string;
  text: string;
  steps: number;
  toolCallSummaries?: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  proposal?: Omit<Proposal, "id" | "merchantId" | "caseId" | "obligationId" | "modelRunId" | "actionVersion" | "createdAt" | "status" | "policy" | "requiresApproval"> & { type: Proposal["type"] };
}

export interface ChatInvocationInput {
  context: RecoveryChatToolContext;
  prompt: string;
  selectedCaseId?: string;
  anchorCaseId: string;
  inputHash: string;
  invocationReason: "explicit_chat";
}

export interface AgentChatResult {
  provider: AgentProvider;
  model: string;
  text: string;
  steps: number;
  toolCallSummaries: string[];
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
}

const remoteProposalSchema = proposalSchema.extend({ type: z.enum(["recovery_message", "document_response", "signal_merge", "pause_or_resume", "promise_schedule", "escalation"]) });
const codexOutputSchema = z.object({
  text: z.string().min(1).max(4000),
  steps: z.number().int().min(0).max(5).optional(),
  toolCallSummaries: z.array(z.string().min(1).max(120)).max(5).optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative().optional(), outputTokens: z.number().int().nonnegative().optional(), totalTokens: z.number().int().nonnegative().optional() }).strict().optional(),
  proposal: remoteProposalSchema.optional()
}).strict();

const CODEX_MAX_STEPS = 5;
const CODEX_DEFAULT_TIMEOUT_MS = 45_000;
const CODEX_MAX_TIMEOUT_MS = 120_000;

const CODEX_OUTPUT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["text"],
  properties: {
    text: { type: "string", minLength: 1, maxLength: 4000 },
    steps: { type: "integer", minimum: 0, maximum: CODEX_MAX_STEPS },
    toolCallSummaries: { type: "array", maxItems: CODEX_MAX_STEPS, items: { type: "string", minLength: 1, maxLength: 120 } },
    usage: {
      type: "object",
      additionalProperties: false,
      properties: {
        inputTokens: { type: "integer", minimum: 0 },
        outputTokens: { type: "integer", minimum: 0 },
        totalTokens: { type: "integer", minimum: 0 }
      }
    },
    proposal: {
      type: "object",
      additionalProperties: false,
      required: ["type", "intendedOutcome", "recipient", "scope", "channel", "payload", "evidenceIds", "uncertainty", "explanation"],
      properties: {
        type: { enum: ["recovery_message", "document_response", "signal_merge", "pause_or_resume", "promise_schedule", "escalation"] },
        intendedOutcome: { type: "string", minLength: 1, maxLength: 300 },
        recipient: { type: "string", minLength: 1, maxLength: 320 },
        scope: { type: "string", minLength: 1, maxLength: 300 },
        channel: { enum: ["email", "system"] },
        payload: { type: "object" },
        evidenceIds: { type: "array", maxItems: 20, items: { type: "string" } },
        uncertainty: { type: "string", minLength: 1, maxLength: 500 },
        explanation: { type: "string", minLength: 1, maxLength: 700 }
      }
    }
  }
} as const;

function toolsForWorkflow(context: RecoveryToolContext, workflow: AgentInvocationInput["workflow"]) {
  const allTools = recoveryTools(context);
  return (workflow === "failed_purchase"
    ? { read_case_summary: allTools.read_case_summary, read_payment_failure: allTools.read_payment_failure, find_related_signals: allTools.find_related_signals, read_active_policies: allTools.read_active_policies, propose_recovery_message: allTools.propose_recovery_message, finish_investigation: allTools.finish_investigation }
    : workflow === "invoice_resolution"
      ? { read_case_summary: allTools.read_case_summary, search_customer_messages: allTools.search_customer_messages, search_case_documents: allTools.search_case_documents, read_active_policies: allTools.read_active_policies, propose_document_response: allTools.propose_document_response, propose_promise_schedule: allTools.propose_promise_schedule, propose_escalation: allTools.propose_escalation, finish_investigation: allTools.finish_investigation }
      : { read_case_summary: allTools.read_case_summary, read_payment_failure: allTools.read_payment_failure, read_incident_context: allTools.read_incident_context, read_active_policies: allTools.read_active_policies, propose_pause_or_resume: allTools.propose_pause_or_resume, finish_investigation: allTools.finish_investigation }) as ToolSet;
}

export function buildRecoveryAgent(context: RecoveryToolContext, workflow: AgentInvocationInput["workflow"]) {
  return new ToolLoopAgent({
    model: fireworks(FIREWORKS_MODEL),
    instructions: RECOVERY_AGENT_INSTRUCTIONS,
    tools: toolsForWorkflow(context, workflow),
    stopWhen: stepCountIs(5),
    temperature: 0.1
  });
}

export function buildRecoveryChatAgent(context: RecoveryChatToolContext) {
  return new ToolLoopAgent({
    model: fireworks(FIREWORKS_MODEL),
    instructions: RECOVERY_CHAT_AGENT_INSTRUCTIONS,
    tools: recoveryChatTools(context),
    stopWhen: stepCountIs(5),
    temperature: 0.1
  });
}

type AgentSdkUsage = { inputTokens?: number; outputTokens?: number; totalTokens?: number };
type AgentSdkResult = { text?: string; steps?: unknown[]; usage?: AgentSdkUsage };
type ChatAgentExecutor = { generate(input: { prompt: string }): Promise<AgentSdkResult> };
type ChatAgentFactory = (context: RecoveryChatToolContext) => ChatAgentExecutor;

const defaultChatAgentFactory: ChatAgentFactory = (context) => buildRecoveryChatAgent(context) as unknown as ChatAgentExecutor;

function toolCallSummaries(steps: unknown[] | undefined) {
  const summaries: string[] = [];
  for (const step of steps || []) {
    const stepRecord = recordValue(step);
    const calls = Array.isArray(stepRecord?.toolCalls) ? stepRecord.toolCalls : [];
    for (const call of calls) {
      const callRecord = recordValue(call);
      const name = stringValue(callRecord?.toolName) || stringValue(callRecord?.name);
      if (name) summaries.push(name);
    }
  }
  return [...new Set(summaries)].slice(0, 5);
}

function compactChatCase(value: unknown) {
  const record = recordValue(value);
  if (!record) return undefined;
  const customer = recordValue(record.customer);
  const obligation = recordValue(record.obligation);
  return {
    id: record.id,
    workflow: record.workflow,
    state: record.state,
    priority: record.priority,
    blocker: record.blocker,
    confidence: record.confidence,
    reason: record.reason,
    nextAction: record.nextAction,
    customer: customer && { id: customer.id, displayName: customer.displayName, type: customer.type },
    obligation: obligation && { id: obligation.id, kind: obligation.kind, amountDue: obligation.amountDue, amountPaid: obligation.amountPaid, currency: obligation.currency, orderRef: obligation.orderRef, invoiceRef: obligation.invoiceRef }
  };
}

async function buildChatPrompt(input: ChatInvocationInput) {
  const workspace = await input.context.readWorkspaceSummary();
  const selectedCase = input.selectedCaseId ? compactChatCase(await input.context.readCaseSummary(input.selectedCaseId)) : undefined;
  return `${RECOVERY_CHAT_AGENT_INSTRUCTIONS}

Use the supplied snapshot as the starting point, then call the narrowest read-only or bounded operation needed for the merchant's request. The snapshot is tenant-scoped and may contain clearly labelled Demo/Fixture records. Never treat fixture evidence or simulated payment status as live.

Merchant request: ${input.prompt}
Selected case ID: ${input.selectedCaseId || "none"}
Workspace snapshot: ${JSON.stringify({ workspace, selectedCase })}`;
}

class FixtureAgentProvider {
  readonly provider = "fixture" as const;
  async invoke(input: AgentInvocationInput): Promise<AgentInvocationResult> {
    return { provider: this.provider, model: "scripted-fixture-recovery-v1", text: `Deterministic fixture review for ${input.caseId}.`, steps: 0, toolCallSummaries: ["fixture_provider_selected", "deterministic_policy_path"] };
  }

  async invokeChat(input: ChatInvocationInput): Promise<AgentChatResult> {
    const workspace = await input.context.readWorkspaceSummary();
    const workspaceRecord = recordValue(workspace);
    const lower = input.prompt.toLowerCase();
    const workspaceCases = await input.context.readWorkspaceCases();
    const promptCase = workspaceCases.find((item) => {
      const customer = recordValue(item.customer);
      const name = typeof customer?.displayName === "string" ? customer.displayName.toLowerCase() : "";
      return name.length > 0 && lower.includes(name);
    });
    const targetCaseId = typeof promptCase?.id === "string" ? promptCase.id : input.selectedCaseId;
    const selected = targetCaseId ? await input.context.readCaseSummary(targetCaseId) : undefined;
    const selectedName = selected?.customer.displayName || "the workspace";
    if (targetCaseId && /\b(pause|stop outreach|do not contact|don't contact)\b/.test(lower)) {
      const pauseUntil = lower.includes("friday") ? await input.context.resolveContactTime("Friday") : undefined;
      const paused = await input.context.pauseOutreach(targetCaseId, `Fixture agent applied the merchant's bounded instruction${pauseUntil ? ` until ${pauseUntil}` : ""}`, pauseUntil);
      return { provider: this.provider, model: "scripted-fixture-recovery-chat-v1", text: `Fixture agent (no model call): I paused outreach for ${paused.id === selected?.id ? selectedName : "the requested case"}${pauseUntil ? ` until ${pauseUntil}` : ""}. No customer-facing action was sent.`, steps: 2, toolCallSummaries: ["fixture_chat_provider", "pause_outreach"] };
    }
    if (targetCaseId && /\b(unpause|resume|reopen)\b/.test(lower)) {
      const resumed = await input.context.resumeOutreach(targetCaseId);
      return { provider: this.provider, model: "scripted-fixture-recovery-chat-v1", text: `Fixture agent (no model call): I resumed the requested case (${resumed.id}) for an evidence recheck. No customer-facing action was sent.`, steps: 2, toolCallSummaries: ["fixture_chat_provider", "resume_outreach"] };
    }
    if (targetCaseId && /\b(investigate|review evidence|look into|find the blocker)\b/.test(lower)) {
      const queued = await input.context.requestInvestigation(targetCaseId);
      return { provider: this.provider, model: "scripted-fixture-recovery-chat-v1", text: `Fixture agent (no model call): I ${queued.status === "already_queued" ? "confirmed that" : "queued"} a bounded evidence investigation for ${targetCaseId}. The worker will retrieve only scoped evidence; no external action was sent.`, steps: 2, toolCallSummaries: ["fixture_chat_provider", "investigate_case"] };
    }
    const caseCount = Number(workspaceRecord?.openCaseCount || 0);
    const affectedCustomers = Array.isArray(workspaceRecord?.affectedCustomers) ? workspaceRecord.affectedCustomers.filter((item): item is string => typeof item === "string") : [];
    const workspaceAnswer = /which customers?|who .*affected/.test(lower)
      ? `Affected customers: ${affectedCustomers.join(", ") || "none"}.`
      : /how many (issues|cases|problems)/.test(lower)
        ? `There are ${caseCount} open recovery cases across ${affectedCustomers.length} customers.`
        : undefined;
    const selectedAnswer = selected && selected.confidence === 0 && selected.workflow === "invoice_resolution"
      ? `${selectedName} is awaiting evidence retrieval. External evidence not retrieved yet; no blocker has been classified.`
      : selected
        ? `${selectedName} is ${selected.state} with ${selected.blocker.replaceAll("_", " ")} as the current blocker.`
        : undefined;
    return {
      provider: this.provider,
      model: "scripted-fixture-recovery-chat-v1",
      text: `Fixture agent (no model call): I received “${input.prompt}”. ${workspaceAnswer || selectedAnswer || (selected ? `${selectedName} is ${selected.state}.` : `There are ${caseCount} open recovery cases in this demo workspace.`)} This is Demo/Fixture data; ask for a bounded investigation or action when you want the deterministic workflow to proceed.`,
      steps: 1,
      toolCallSummaries: ["fixture_chat_provider", selected ? "read_case_summary" : "read_workspace_summary"]
    };
  }
}

export class FireworksAgentProvider {
  readonly provider = "fireworks" as const;
  constructor(private readonly chatAgentFactory: ChatAgentFactory = defaultChatAgentFactory) {}

  async invoke(input: AgentInvocationInput): Promise<AgentInvocationResult> {
    const config = assertAgentCredentials();
    const agent = buildRecoveryAgent(input.context, input.workflow);
    const result = await agent.generate({ prompt: input.prompt });
    const usage = result.usage ? { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens, totalTokens: result.usage.totalTokens } : undefined;
    return { provider: this.provider, model: config.fireworksModel, text: result.text, steps: result.steps?.length || 0, usage, toolCallSummaries: ["fireworks_tool_loop"] };
  }

  async invokeChat(input: ChatInvocationInput): Promise<AgentChatResult> {
    const config = assertAgentCredentials();
    const agent = this.chatAgentFactory(input.context);
    const result = await agent.generate({ prompt: await buildChatPrompt(input) });
    const text = result.text?.trim();
    if (!text) throw new Error("FIREWORKS_EMPTY_RESPONSE:Configured Fireworks agent returned no visible response.");
    return {
      provider: this.provider,
      model: config.fireworksModel,
      text,
      steps: Math.min(5, Math.max(1, result.steps?.length || 1)),
      usage: result.usage,
      toolCallSummaries: ["fireworks_chat", ...toolCallSummaries(result.steps)].slice(0, 5)
    };
  }
}

type CodexRpcMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown; data?: unknown };
};

type CodexNotificationListener = (message: CodexRpcMessage) => void;

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boundedTimeoutMs() {
  const configured = Number(process.env.CODEX_APP_SERVER_TIMEOUT_MS || CODEX_DEFAULT_TIMEOUT_MS);
  if (!Number.isFinite(configured)) return CODEX_DEFAULT_TIMEOUT_MS;
  return Math.min(CODEX_MAX_TIMEOUT_MS, Math.max(1_000, Math.floor(configured)));
}

function codexChildEnvironment(): NodeJS.ProcessEnv {
  // Do not forward provider credentials, browser session data, database URLs,
  // or arbitrary application environment to the native app-server process.
  const allowed = ["PATH", "Path", "PATHEXT", "SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "USERPROFILE", "HOME", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "APPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "CODEX_HOME", "LANG", "LC_ALL", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"];
  const environment = { NODE_ENV: process.env.NODE_ENV || "production" } as NodeJS.ProcessEnv;
  for (const name of allowed) if (process.env[name]) environment[name] = process.env[name];
  return environment;
}

class CodexAppServerClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private readonly listeners = new Set<CodexNotificationListener>();
  private buffer = "";
  private nextId = 1;
  private closed = false;

  constructor(command: string, cwd: string, spawnProcess: typeof spawn = spawn) {
    this.child = spawnProcess(command, ["app-server", "--stdio"], { cwd, env: codexChildEnvironment(), stdio: ["pipe", "pipe", "pipe"] }) as ChildProcessWithoutNullStreams;
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => this.acceptOutput(chunk));
    this.child.stderr.resume();
    this.child.on("error", (error) => this.failPending(error instanceof Error ? error : new Error("CODEX_APP_SERVER_PROCESS_ERROR")));
    this.child.on("close", () => this.failPending(new Error("CODEX_APP_SERVER_CLOSED")));
  }

  onNotification(listener: CodexNotificationListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = boundedTimeoutMs()): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CODEX_APP_SERVER_CLOSED"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CODEX_APP_SERVER_TIMEOUT:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error("CODEX_APP_SERVER_WRITE_FAILED"));
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.failPending(new Error("CODEX_APP_SERVER_CLIENT_CLOSED"));
    }
    if (!this.child.killed) this.child.kill();
  }

  private write(message: Record<string, unknown>) {
    if (this.closed) throw new Error("CODEX_APP_SERVER_CLOSED");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private acceptOutput(chunk: string) {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.acceptMessage(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private acceptMessage(line: string) {
    let message: CodexRpcMessage;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!recordValue(parsed)) throw new Error("not-an-object");
      message = parsed as CodexRpcMessage;
    } catch {
      this.failPending(new Error("CODEX_APP_SERVER_INVALID_MESSAGE"));
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      if (typeof message.id !== "number") return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`CODEX_APP_SERVER_RPC_ERROR:${String(message.error.message || message.error.code || "unknown")}`));
      else pending.resolve(message.result);
      return;
    }

    if (message.method) {
      for (const listener of this.listeners) listener(message);
      // The recovery client provides no server-side tool or approval channel.
      // Answer unexpected requests explicitly so the native server cannot hang
      // waiting for browser secrets, user input, or an unsafe permission grant.
      if (message.id !== undefined) {
        try {
          this.write({ id: message.id, error: { code: -32601, message: "Recovery client does not permit server-initiated requests." } });
        } catch {
          this.failPending(new Error("CODEX_APP_SERVER_WRITE_FAILED"));
        }
      }
    }
  }

  private failPending(error: Error) {
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function normalizeUsage(value: unknown) {
  const record = recordValue(value);
  const last = recordValue(record?.last) || record;
  if (!last) return undefined;
  const numberValue = (candidate: unknown) => typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0 ? Math.floor(candidate) : undefined;
  const usage = { inputTokens: numberValue(last.inputTokens), outputTokens: numberValue(last.outputTokens), totalTokens: numberValue(last.totalTokens) };
  return Object.values(usage).some((item) => item !== undefined) ? usage : undefined;
}

async function buildCodexPrompt(input: AgentInvocationInput) {
  const view = await input.context.readCaseSummary(input.caseId);
  const snapshot: Record<string, unknown> = {
    case: {
      id: view.id,
      workflow: view.workflow,
      state: view.state,
      blocker: view.blocker,
      confidence: view.confidence,
      reason: view.reason,
      nextAction: view.nextAction,
      customer: view.customer,
      obligation: view.obligation,
      invoice: view.invoice,
      signals: view.signals,
      paymentAttempt: view.paymentAttempt,
      incident: view.incident,
      messages: view.messages.map((message) => ({ id: message.id, direction: message.direction, subject: message.subject, body: message.body.slice(0, 2_000), participants: message.participants, providerId: message.providerId, receivedAt: message.receivedAt, sentAt: message.sentAt })),
      documents: view.documents.map((document) => ({ id: document.id, customerId: document.customerId, obligationId: document.obligationId, providerId: document.providerId, name: document.name, mimeType: document.mimeType, extractedText: document.extractedText.slice(0, 2_500), permission: document.permission, sourceUrl: document.sourceUrl }))
    },
    policy: await input.context.readActivePolicies(input.caseId),
    inputHash: input.inputHash,
    invocationReason: input.invocationReason
  };
  if (input.workflow === "failed_purchase") {
    snapshot.paymentFailure = await input.context.readPaymentFailure(input.caseId);
    snapshot.relatedSignals = await input.context.findRelatedSignals(input.caseId);
  } else if (input.workflow === "invoice_resolution") {
    snapshot.customerMessages = await input.context.searchCustomerMessages(input.caseId);
    snapshot.caseDocuments = await input.context.searchCaseDocuments(input.caseId);
  } else {
    snapshot.incidentContext = await input.context.readIncidentContext(input.caseId);
  }
  const encodedSnapshot = JSON.stringify(snapshot).slice(0, 28_000);
  return `${RECOVERY_AGENT_INSTRUCTIONS}

This is a bounded native Codex app-server turn. The host has already read the scoped evidence below. You have no external tools, no permission to send messages or mutate payment state, and no access to browser secrets. Use only the supplied snapshot. Return exactly one JSON object matching the output schema: text is a concise visible explanation; proposal is optional and must cite only supplied evidence IDs. Never claim payment success. Do not include markdown fences or hidden reasoning.

Task: ${input.prompt}
Case: ${input.caseId}
Workflow: ${input.workflow}
Invocation reason: ${input.invocationReason}
Scoped snapshot: ${encodedSnapshot}`;
}

async function runCodexTurn(client: CodexAppServerClient, threadId: string, prompt: string, timeoutMs: number) {
  let turnId: string | undefined;
  let deltaText = "";
  let completedText = "";
  let itemCount = 0;
  let nativeUsage: AgentInvocationResult["usage"];
  const toolCallSummaries: string[] = [];
  let interrupted = false;
  let cleanup: () => void = () => undefined;

  const completion = new Promise<{ text: string; steps: number; usage?: AgentInvocationResult["usage"]; toolCallSummaries: string[] }>((resolve, reject) => {
    let settled = false;
    let unsubscribe: () => void = () => undefined;
    const cleanUp = () => {
      clearTimeout(timer);
      unsubscribe();
    };
    const finishError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanUp();
      reject(error);
    };
    const finishSuccess = (turn: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      cleanUp();
      const items = Array.isArray(turn.items) ? turn.items : [];
      const turnAgentText = items.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item && item.type === "agentMessage")).map((item) => stringValue(item.text) || "").join("");
      const text = completedText || turnAgentText || deltaText;
      resolve({ text, steps: Math.min(CODEX_MAX_STEPS, Math.max(1, itemCount)), usage: nativeUsage, toolCallSummaries: [...new Set(toolCallSummaries)] });
    };
    unsubscribe = client.onNotification((message) => {
      const params = recordValue(message.params);
      if (!params) return;
      const messageThreadId = stringValue(params.threadId);
      if (messageThreadId && messageThreadId !== threadId) return;
      const messageTurn = recordValue(params.turn);
      const messageTurnId = stringValue(params.turnId) || stringValue(messageTurn?.id);
      if (messageTurnId && turnId && messageTurnId !== turnId) return;
      if (messageTurnId && !turnId) turnId = messageTurnId;

      if (message.method === "item/started") {
        itemCount += 1;
        const item = recordValue(params.item);
        const itemType = stringValue(item?.type);
        if (itemType) toolCallSummaries.push(`codex:${itemType}`);
        if (itemCount > CODEX_MAX_STEPS && !interrupted) {
          interrupted = true;
          if (turnId) void client.request("turn/interrupt", { threadId, turnId }, 2_000).catch(() => undefined);
          finishError(new Error("CODEX_APP_SERVER_STEP_LIMIT"));
        }
      } else if (message.method === "item/agentMessage/delta") {
        deltaText += stringValue(params.delta) || "";
      } else if (message.method === "item/completed") {
        const item = recordValue(params.item);
        if (item?.type === "agentMessage") completedText = stringValue(item.text) || completedText;
      } else if (message.method === "thread/tokenUsage/updated") {
        nativeUsage = normalizeUsage(params.tokenUsage);
      } else if (message.method === "error" && params.willRetry !== true) {
        const error = recordValue(params.error);
        finishError(new Error(`CODEX_APP_SERVER_TURN_ERROR:${String(error?.message || "unknown")}`));
      } else if (message.method === "turn/completed") {
        const status = stringValue(messageTurn?.status);
        if (status !== "completed") finishError(new Error(`CODEX_APP_SERVER_TURN_${(status || "FAILED").toUpperCase()}`));
        else finishSuccess(messageTurn || {});
      }
    });
    const timer = setTimeout(() => {
      if (settled) return;
      if (turnId) void client.request("turn/interrupt", { threadId, turnId }, 2_000).catch(() => undefined);
      finishError(new Error("CODEX_APP_SERVER_TIMEOUT"));
    }, timeoutMs);
    cleanup = () => {
      if (settled) return;
      settled = true;
      cleanUp();
      reject(new Error("CODEX_APP_SERVER_CLIENT_CLOSED"));
    };
  });

  try {
    const turnResponse = await client.request<unknown>("turn/start", { threadId, input: [{ type: "text", text: prompt, text_elements: [] }], outputSchema: CODEX_OUTPUT_JSON_SCHEMA }, timeoutMs);
    const turnRecord = recordValue(recordValue(turnResponse)?.turn);
    const responseTurnId = stringValue(turnRecord?.id);
    if (!responseTurnId) throw new Error("CODEX_APP_SERVER_INVALID_TURN_START");
    if (turnId && turnId !== responseTurnId) throw new Error("CODEX_APP_SERVER_TURN_ID_MISMATCH");
    turnId = responseTurnId;
    return await completion;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export class CodexAppServerAgentProvider {
  readonly provider = "codex_app_server" as const;
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  async invoke(input: AgentInvocationInput): Promise<AgentInvocationResult> {
    const config = assertAgentCredentials();
    const timeoutMs = boundedTimeoutMs();
    const client = new CodexAppServerClient(config.codexAppServerCommand, process.cwd(), this.spawnProcess);
    try {
      await client.request("initialize", { clientInfo: { name: "rebound", title: "Rebound", version: "0.1.0" }, capabilities: { experimentalApi: false, requestAttestation: false } }, timeoutMs);
      client.notify("initialized");
      const threadStart = recordValue(await client.request("thread/start", { model: config.codexAppServerModel || null, modelProvider: null, cwd: process.cwd(), approvalPolicy: "never", sandbox: "read-only", environments: [], dynamicTools: [], baseInstructions: RECOVERY_AGENT_INSTRUCTIONS, developerInstructions: "Only return the JSON object requested by the user turn. Keep this thread ephemeral and read-only.", ephemeral: true, threadSource: "rebound" }, timeoutMs));
      const thread = recordValue(threadStart?.thread);
      const threadId = stringValue(thread?.id);
      if (!threadId) throw new Error("CODEX_APP_SERVER_INVALID_THREAD_START");
      const prompt = await buildCodexPrompt(input);
      const turn = await runCodexTurn(client, threadId, prompt, timeoutMs);
      const parsed = codexOutputSchema.safeParse(JSON.parse(turn.text));
      if (!parsed.success) throw new Error("CODEX_APP_SERVER_INVALID_OUTPUT:Native app-server completion did not match the recovery output schema.");
      return { provider: this.provider, model: stringValue(threadStart?.model) || "codex-app-server", text: parsed.data.text, steps: turn.steps, toolCallSummaries: [...new Set([...(turn.toolCallSummaries || []), ...(parsed.data.toolCallSummaries || [])])].slice(0, CODEX_MAX_STEPS), usage: turn.usage, proposal: parsed.data.proposal as AgentInvocationResult["proposal"] };
    } finally {
      client.close();
    }
  }
}

export function getAgentProvider(provider: AgentProvider = runtimeConfig().agentProvider) {
  if (provider === "fixture") return new FixtureAgentProvider();
  if (provider === "fireworks") return new FireworksAgentProvider();
  return new CodexAppServerAgentProvider();
}

export interface RecoveryChatProvider {
  invokeChat(input: ChatInvocationInput): Promise<AgentChatResult>;
}

export function getAgentChatProvider(provider: AgentProvider = runtimeConfig().agentProvider): RecoveryChatProvider {
  if (provider === "fixture") return new FixtureAgentProvider();
  if (provider === "fireworks") return new FireworksAgentProvider();
  throw new Error("AGENT_CHAT_PROVIDER_UNSUPPORTED:Native Codex app-server chat is not enabled for this bounded workspace drawer.");
}

export async function runRecoveryAgent(input: AgentInvocationInput) {
  return getAgentProvider().invoke(input);
}

export async function runRecoveryChat(input: ChatInvocationInput) {
  return getAgentChatProvider().invokeChat(input);
}

export async function runLiveRecoveryAgent(context: RecoveryToolContext, workflow: AgentInvocationInput["workflow"], prompt: string) {
  const result = await getAgentProvider("fireworks").invoke({ context, workflow, prompt, caseId: "legacy", inputHash: "legacy", invocationReason: "explicit_investigation" });
  return { text: result.text, steps: result.steps };
}
