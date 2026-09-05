import "@/server/load-env";
import postgres from "postgres";
import { capabilityStatus, runtimeConfig } from "@/server/config";
import { DEMO_MERCHANT_ID } from "@/shared/constants";
import { createDemoWorld } from "@/server/db/fixture-seed";
import { replaceNormalizedWorld } from "@/server/db/relational-sync";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for db:seed. The default fixture web path remains runnable without PostgreSQL.");
  process.exit(1);
}
if (runtimeConfig().mode !== "fixture") {
  console.error("DEMO_SEED_FIXTURE_ONLY:Refusing demo seed when a non-fixture provider is selected. Run this command with AGENT_PROVIDER=fixture, EVIDENCE_PROVIDER=fixture and PAYMENT_PROVIDER=fixture against an isolated local database.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const world = createDemoWorld(DEMO_MERCHANT_ID, capabilityStatus());
try {
  await sql.begin(async (tx) => {
    await replaceNormalizedWorld(tx, world);
    await tx`
      insert into recovery_state (workspace_id, merchant_id, payload, updated_at)
      values (${world.workspaceId || world.merchant.id}, ${world.merchant.id}, ${JSON.stringify(world)}::jsonb, now())
      on conflict (workspace_id) do update set merchant_id = excluded.merchant_id, payload = excluded.payload, updated_at = now()
    `;
  });
  console.log(`Seeded ${world.merchant.name} demo world in ${world.merchant.mode} mode.`);
} finally {
  await sql.end({ timeout: 5 });
}
