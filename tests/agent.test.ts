import { EventEmitter } from "node:events";
import { spawn as nativeSpawn } from "node:child_process";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexAppServerAgentProvider, type AgentInvocationInput } from "@/server/agent/agent";
import type { RecoveryToolContext } from "@/server/agent/tools";

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
