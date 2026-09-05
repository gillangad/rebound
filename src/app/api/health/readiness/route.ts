import postgres from "postgres";
import { capabilityStatus, runtimeConfig } from "@/server/config";

export const runtime = "nodejs";

export async function GET() {
  const config = runtimeConfig();
  if (!config.databaseUrl) return Response.json({ ok: true, ready: true, storage: "memory", capabilities: capabilityStatus(), detail: "Fixture readiness does not require PostgreSQL." });
  const sql = postgres(config.databaseUrl, { max: 1, idle_timeout: 5 });
  try {
    await sql`select 1`;
    return Response.json({ ok: true, ready: true, storage: "postgres", capabilities: capabilityStatus() });
  } catch (error) {
    return Response.json({ ok: false, ready: false, storage: "postgres", capabilities: capabilityStatus(), detail: error instanceof Error ? error.message : "PostgreSQL readiness check failed." }, { status: 503 });
  } finally {
    await sql.end({ timeout: 2 });
  }
}
