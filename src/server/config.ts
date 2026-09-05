import type { AgentProvider, AppMode, EvidenceProvider, PaymentProvider, RuntimeCapabilities, StorageProvider } from "@/shared/types";

export const DEFAULT_FIREWORKS_MODEL = "accounts/fireworks/models/deepseek-v4-flash-0731";
export const FIREWORKS_MODEL = process.env.FIREWORKS_MODEL || DEFAULT_FIREWORKS_MODEL;

const AGENT_PROVIDERS = ["fixture", "fireworks", "codex_app_server"] as const;
const EVIDENCE_PROVIDERS = ["fixture", "google", "composio"] as const;
const PAYMENT_PROVIDERS = ["fixture", "razorpay_test"] as const;

function pick<T extends string>(name: string, value: string | undefined, allowed: readonly T[], fallback: T): T {
  const selected = value?.trim() || fallback;
  if (!allowed.includes(selected as T)) throw new Error(`INVALID_${name}:${name} must be one of ${allowed.join(", ")}`);
  return selected as T;
}

export function isConfiguredSecret(value: string | undefined) {
  const normalized = value?.trim();
  return Boolean(normalized && !/(replace(?:_with)?|your[_-]?|change[_-]?me|todo)/iu.test(normalized));
}

export function runtimeConfig() {
  const legacyMode = process.env.APP_MODE === "live";
  const databaseUrl = process.env.DATABASE_URL;
  const agentProvider = pick<AgentProvider>("AGENT_PROVIDER", process.env.AGENT_PROVIDER, AGENT_PROVIDERS, legacyMode ? "fireworks" : "fixture");
  const evidenceProvider = pick<EvidenceProvider>("EVIDENCE_PROVIDER", process.env.EVIDENCE_PROVIDER, EVIDENCE_PROVIDERS, legacyMode ? "google" : "fixture");
  const paymentProvider = pick<PaymentProvider>("PAYMENT_PROVIDER", process.env.PAYMENT_PROVIDER, PAYMENT_PROVIDERS, legacyMode ? "razorpay_test" : "fixture");
  const storageProvider: StorageProvider = databaseUrl ? "postgres" : "memory";
  const mode: AppMode = agentProvider === "fixture" && evidenceProvider === "fixture" && paymentProvider === "fixture" ? "fixture" : "live";
  return {
    mode,
    agentProvider,
    evidenceProvider,
    paymentProvider,
    storageProvider,
    databaseUrl,
    fireworksApiKey: process.env.FIREWORKS_API_KEY,
    fireworksModel: process.env.FIREWORKS_MODEL || DEFAULT_FIREWORKS_MODEL,
    codexAppServerUrl: process.env.CODEX_APP_SERVER_URL,
    codexAppServerCommand: process.env.CODEX_APP_SERVER_COMMAND || "codex",
    codexAppServerModel: process.env.CODEX_APP_SERVER_MODEL,
    googleAccessToken: process.env.GOOGLE_ACCESS_TOKEN,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    fixtureWebhookSecret: process.env.FIXTURE_WEBHOOK_SECRET || "fixture-only-secret",
    appBaseUrl: process.env.APP_BASE_URL || "http://localhost:3000",
    demoSessionSecret: process.env.DEMO_SESSION_SECRET || "local-fixture-demo-session-secret-change-me",
    googleClientId: process.env.GOOGLE_CLIENT_ID,
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI,
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY
  };
}

export function assertAgentCredentials() {
  const config = runtimeConfig();
  if (config.agentProvider === "fixture") return config;
  if (config.agentProvider === "fireworks" && !isConfiguredSecret(config.fireworksApiKey)) throw new Error("AGENT_FIREWORKS_KEY_REQUIRED:AGENT_PROVIDER=fireworks requires FIREWORKS_API_KEY.");
  if (config.agentProvider === "codex_app_server" && (config.codexAppServerUrl !== "stdio://" || !config.codexAppServerCommand.trim())) throw new Error("AGENT_CODEX_APP_SERVER_CONFIG_REQUIRED:AGENT_PROVIDER=codex_app_server requires CODEX_APP_SERVER_URL=stdio:// and an installed native Codex command.");
  return config;
}

export function assertEvidenceProvider() {
  const config = runtimeConfig();
  if (config.evidenceProvider === "fixture") return config;
  if (config.evidenceProvider === "google" && isConfiguredSecret(config.googleAccessToken)) return config;
  if (config.evidenceProvider === "google") throw new Error("EVIDENCE_GOOGLE_TOKEN_REQUIRED:EVIDENCE_PROVIDER=google requires GOOGLE_ACCESS_TOKEN or an encrypted connected Google token.");
  throw new Error("EVIDENCE_COMPOSIO_NOT_IMPLEMENTED:EVIDENCE_PROVIDER=composio is a deferred connector boundary in this build.");
}

export function assertPaymentCredentials() {
  const config = runtimeConfig();
  if (config.paymentProvider === "fixture") return config;
  if (!config.razorpayKeyId || !config.razorpayKeyId.startsWith("rzp_test_") || !isConfiguredSecret(config.razorpayKeyId)) throw new Error("PAYMENT_RAZORPAY_TEST_KEY_REQUIRED:PAYMENT_PROVIDER=razorpay_test requires an RZP test key id beginning with rzp_test_.");
  if (!isConfiguredSecret(config.razorpayKeySecret)) throw new Error("PAYMENT_RAZORPAY_SECRET_REQUIRED:PAYMENT_PROVIDER=razorpay_test requires RAZORPAY_KEY_SECRET.");
  return config;
}

export function assertWebhookCredentials() {
  const config = runtimeConfig();
  if (config.paymentProvider === "fixture") return config;
  if (!isConfiguredSecret(config.razorpayWebhookSecret)) throw new Error("PAYMENT_RAZORPAY_WEBHOOK_SECRET_REQUIRED:PAYMENT_PROVIDER=razorpay_test requires RAZORPAY_WEBHOOK_SECRET.");
  return config;
}

/** Backwards-compatible name used by the older adapter boundary. */
export function assertLiveCredentials() {
  const config = runtimeConfig();
  if (config.storageProvider !== "postgres") throw new Error("LIVE_DATABASE_REQUIRED:Durable provider operation requires DATABASE_URL.");
  assertAgentCredentials();
  assertEvidenceProvider();
  assertPaymentCredentials();
  assertWebhookCredentials();
  return config;
}

export function capabilityStatus(): RuntimeCapabilities {
  const config = runtimeConfig();
  const agentReady = config.agentProvider === "fixture" || (config.agentProvider === "fireworks" ? isConfiguredSecret(config.fireworksApiKey) : config.codexAppServerUrl === "stdio://" && Boolean(config.codexAppServerCommand.trim()));
  const paymentReady = config.paymentProvider === "fixture" || Boolean(config.razorpayKeyId?.startsWith("rzp_test_") && isConfiguredSecret(config.razorpayKeyId) && isConfiguredSecret(config.razorpayKeySecret) && isConfiguredSecret(config.razorpayWebhookSecret));
  return {
    agent: config.agentProvider === "fixture"
      ? { provider: config.agentProvider, status: "fixture", label: "Fixture agent", model: "scripted-fixture-recovery-v1", detail: "Deterministic local decisions; no model call." }
      : { provider: config.agentProvider, status: agentReady ? "ready" : "not_configured", label: config.agentProvider === "fireworks" ? "Fireworks agent" : "Local Codex app-server (stdio)", model: config.agentProvider === "fireworks" ? config.fireworksModel : config.codexAppServerModel || "native app-server default", detail: agentReady ? config.agentProvider === "fireworks" ? "Server-side Fireworks inference is configured; no fixture fallback is used." : "Native Codex app-server JSON-RPC over stdio; the local command must be installed and authenticated independently." : config.agentProvider === "fireworks" ? "Set FIREWORKS_API_KEY; no fixture fallback is used." : "Set CODEX_APP_SERVER_URL=stdio://; no fixture fallback is used." },
    evidence: config.evidenceProvider === "fixture"
      ? { provider: config.evidenceProvider, status: "fixture", label: "Fixture evidence", detail: "Simulated provider corpus is retrieved and validated; records are labelled Demo evidence." }
      : config.evidenceProvider === "google"
        ? { provider: config.evidenceProvider, status: isConfiguredSecret(config.googleAccessToken) ? "ready" : "not_configured", label: "Google Email + Drive", detail: isConfiguredSecret(config.googleAccessToken) ? "Server-side Google access token configured; investigation retrieves and validates provider evidence." : "Set GOOGLE_ACCESS_TOKEN or connect an encrypted Google token; no fixture fallback is used." }
        : { provider: config.evidenceProvider, status: "unsupported", label: "Composio boundary", detail: "Deferred connector boundary; no Composio calls are made." },
    payment: config.paymentProvider === "fixture"
      ? { provider: config.paymentProvider, status: "fixture", label: "Fixture payments", detail: "Payment verification is simulated and never represents real money." }
      : { provider: config.paymentProvider, status: paymentReady ? "ready" : "not_configured", label: "Razorpay test", detail: paymentReady ? "Razorpay test credentials configured server-side." : "Selected Razorpay test provider is not configured; no fixture fallback is used." },
    storage: config.storageProvider === "postgres"
      ? { provider: config.storageProvider, status: "ready", label: "PostgreSQL", detail: "Durable tenant-scoped snapshots and normalized rows." }
      : { provider: config.storageProvider, status: "not_configured", label: "In-process local store", detail: "Convenience fixture store only; hosted behavior requires PostgreSQL." }
  };
}
