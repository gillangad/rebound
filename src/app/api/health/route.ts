import { runtimeConfig } from "@/server/config";

export const runtime = "nodejs";

export async function GET() {
  const config = runtimeConfig();
  return Response.json({ ok: true, mode: config.mode, databaseConfigured: Boolean(config.databaseUrl), providers: { agent: config.agentProvider, evidence: config.evidenceProvider, payment: config.paymentProvider, storage: config.storageProvider } });
}
