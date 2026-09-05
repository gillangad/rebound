import { EventEmitter } from "node:events";
import { spawn as nativeSpawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAgentProvider, FireworksAgentProvider, type AgentInvocationInput } from "@/server/agent/agent";
import type { RecoveryChatToolContext, RecoveryToolContext } from "@/server/agent/tools";
import { recoveryChatTools } from "@/server/agent/tools";

afterEach(() => vi.unstubAllEnvs());

describe("native Codex app-server provider", () => {
  it("uses the bounded initialize/thread/turn JSON-RPC lifecycle and validates streamed output", async () => {
    vi.stubEnv("AGENT_PROVIDER", "codex_app_server");
    vi.stubEnv("CODEX_APP_SERVER_URL", "stdio://");
    vi.stubEnv("CODEX_APP_SERVER_COMMAND", "codex");
    vi.stubEnv("CODEX_APP_SERVER_TIMEOUT_MS", "2000");
    vi.stubEnv("FIREWORKS_API_KEY", "must-not-forward");

    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const requests: Array<Record<string, unknown>> = [];
    const processLike = new EventEmitter() as EventEmitter & { stdin: Writable; stdout: PassThrough; stderr: PassThrough; killed: boolean; kill: () => boolean };
    processLike.stdout = stdout;
    processLike.stderr = stderr;
    processLike.killed = false;
    processLike.kill = vi.fn(() => { processLike.killed = true; return true; });

    const send = (message: Record<string, unknown>) => stdout.write(`${JSON.stringify(message)}\n`);
    const inputStream = new Writable({
      write(chunk, _encoding, callback) {
        const message = JSON.parse(String(chunk)) as Record<string, unknown>;
        requests.push(message);
        if (message.method === "initialize") send({ id: message.id, result: { userAgent: "test" } });
        if (message.method === "thread/start") send({ id: message.id, result: { thread: { id: "thread-test" }, model: "gpt-test" } });
        if (message.method === "turn/start") {
          send({ id: message.id, result: { turn: { id: "turn-test" } } });
          setTimeout(() => {
            send({ method: "turn/started", params: { threadId: "thread-test", turn: { id: "turn-test" } } });
            send({ method: "item/started", params: { threadId: "thread-test", turnId: "turn-test", item: { type: "agentMessage", id: "item-test" } } });
            const output = JSON.stringify({ text: "native completion", steps: 4, toolCallSummaries: ["read_case_summary"] });
            send({ method: "item/agentMessage/delta", params: { threadId: "thread-test", turnId: "turn-test", itemId: "item-test", delta: output } });
            send({ method: "item/completed", params: { threadId: "thread-test", turnId: "turn-test", item: { type: "agentMessage", id: "item-test", text: output } } });
            send({ method: "thread/tokenUsage/updated", params: { threadId: "thread-test", turnId: "turn-test", tokenUsage: { last: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } } } });
            send({ method: "turn/completed", params: { threadId: "thread-test", turn: { id: "turn-test", status: "completed", items: [] } } });
          }, 0);
        }
        callback();
      }
    });
    processLike.stdin = inputStream;
    let spawnedOptions: { env: NodeJS.ProcessEnv } | undefined;
    const spawnProcess = vi.fn((_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => { spawnedOptions = options; return processLike; });
    const view = {
      id: "case-test",
      workflow: "failed_purchase",
      state: "detected",
      blocker: "payment_failed",
      confidence: 0.9,
      reason: "Payment failed",
      nextAction: "Investigate",
      customer: { id: "customer-test", type: "individual", displayName: "Test Customer", email: "test@example.com" },
      obligation: { id: "obligation-test", customerId: "customer-test", kind: "purchase", amountDue: 1000, amountPaid: 0, currency: "INR", status: "open" },
      signals: [],
      messages: [],
      documents: [],
      proposals: [],
      latestAudit: []
    };
    const context: RecoveryToolContext = {
      readCaseSummary: async () => view as never,
      readPaymentFailure: async () => ({ status: "failed" }),
      findRelatedSignals: async () => [],
      searchCustomerMessages: async () => [],
      searchCaseDocuments: async () => [],
      readActivePolicies: async () => ({}) as never,
      readIncidentContext: async () => ({ status: "no_incident" }),
      createProposal: async () => { throw new Error("not used"); }
    };
    const agentInput: AgentInvocationInput = { context, workflow: "failed_purchase", prompt: "Read the scoped case and propose only safe action.", caseId: "case-test", inputHash: "hash-test", invocationReason: "explicit_investigation" };

    const result = await new CodexAppServerAgentProvider(spawnProcess as unknown as typeof nativeSpawn).invoke(agentInput);

    expect(result).toMatchObject({ provider: "codex_app_server", model: "gpt-test", text: "native completion", steps: 1, usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 } });
    expect(result.toolCallSummaries).toContain("codex:agentMessage");
    expect(requests.map((request) => request.method)).toEqual(["initialize", "initialized", "thread/start", "turn/start"]);
    expect(spawnedOptions?.env.FIREWORKS_API_KEY).toBeUndefined();
    expect(processLike.kill).toHaveBeenCalled();
  });
});

describe("bounded Fireworks chat provider", () => {
  function chatContext(): RecoveryChatToolContext {
    const view = {
      id: "case-city",
      workflow: "invoice_resolution",
      state: "detected",
      blocker: "missing_document",
      confidence: 0,
      reason: "Evidence review is pending",
      nextAction: "Review evidence",
      customer: { id: "customer-city", type: "business", displayName: "City Interiors", email: "city@example.com" },
      obligation: { id: "obligation-city", customerId: "customer-city", kind: "invoice", amountDue: 48000000, amountPaid: 0, currency: "INR", invoiceRef: "NSO-INV-2048" },
      signals: [],
      messages: [],
      documents: [],
      proposals: [],
      latestAudit: []
    };
    const scoped = async (caseId: string) => {
      if (caseId !== "case-city") throw new Error("TENANT_SCOPE_BLOCKED");
      return view as never;
    };
    return {
      readWorkspaceSummary: async () => ({ openCaseCount: 1, affectedCustomers: ["City Interiors"], demo: true }),
      readWorkspaceCases: async () => [{ id: "case-city", customer: { displayName: "City Interiors" }, state: "detected", blocker: "missing_document" }],
      readHistory: async () => [],
      readCaseSummary: scoped,
      readPaymentFailure: async (caseId) => { await scoped(caseId); return { status: "no_attempt_recorded" }; },
      findRelatedSignals: async (caseId) => { await scoped(caseId); return []; },
      searchCustomerMessages: async (caseId) => { await scoped(caseId); return []; },
      searchCaseDocuments: async (caseId) => { await scoped(caseId); return []; },
      readActivePolicies: async (caseId) => { await scoped(caseId); return {} as never; },
      readIncidentContext: async (caseId) => { await scoped(caseId); return { status: "no_incident" }; },
      createProposal: async () => { throw new Error("not used"); },
      requestInvestigation: async (caseId) => { await scoped(caseId); return { status: "queued" }; },
      pauseOutreach: async (caseId) => { await scoped(caseId); return view as never; },
      resumeOutreach: async (caseId) => { await scoped(caseId); return view as never; },
      resolveContactTime: async () => "2026-09-11T03:30:00.000Z"
    };
  }

  it("routes substantive chat to Fireworks and exposes bounded tool activity", async () => {
    vi.stubEnv("AGENT_PROVIDER", "fireworks");
    vi.stubEnv("FIREWORKS_API_KEY", "configured-for-test");
    vi.stubEnv("FIREWORKS_MODEL", "accounts/fireworks/models/test-model");
    const generate = vi.fn(async ({ prompt }: { prompt: string }) => ({
      text: prompt.includes("City Interiors") ? "City Interiors is blocked pending evidence retrieval." : "The scoped case is awaiting evidence.",
      steps: [{ toolCalls: [{ toolName: "read_workspace_summary" }, { toolName: "read_case_summary" }] }],
      usage: { inputTokens: 42, outputTokens: 12, totalTokens: 54 }
    }));
    const provider = new FireworksAgentProvider(() => ({ generate }));

    const result = await provider.invokeChat({ context: chatContext(), prompt: "What are the blockers right now?", selectedCaseId: "case-city", anchorCaseId: "case-city", inputHash: "chat-hash", invocationReason: "explicit_chat" });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate.mock.calls[0]?.[0].prompt).toContain("City Interiors");
    expect(result).toMatchObject({ provider: "fireworks", model: "accounts/fireworks/models/test-model", text: "City Interiors is blocked pending evidence retrieval.", usage: { totalTokens: 54 } });
    expect(result.toolCallSummaries).toEqual(["fireworks_chat", "read_workspace_summary", "read_case_summary"]);
  });

  it("keeps chat tools tenant-scoped and routes action tools through their deterministic context", async () => {
    const pause = vi.fn(async (caseId: string, reason: string) => { if (caseId !== "case-city") throw new Error("TENANT_SCOPE_BLOCKED"); return { id: caseId, reason } as never; });
    const context = { ...chatContext(), pauseOutreach: pause };
    const tools = recoveryChatTools(context);
    const readCase = tools.read_case_summary as unknown as { execute(input: { caseId: string }): Promise<unknown> };
    const pauseTool = tools.pause_outreach as unknown as { execute(input: { caseId: string; reason: string }): Promise<unknown> };

    await expect(readCase.execute({ caseId: "foreign-case" })).rejects.toThrow("TENANT_SCOPE_BLOCKED");
    await pauseTool.execute({ caseId: "case-city", reason: "Merchant requested a pause" });
    expect(pause).toHaveBeenCalledWith("case-city", "Merchant requested a pause", undefined);
  });
});
