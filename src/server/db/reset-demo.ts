import "@/server/load-env";
import postgres from "postgres";
import { capabilityStatus, runtimeConfig } from "@/server/config";
import { DEMO_MERCHANT_ID } from "@/shared/constants";
import { createDemoWorld } from "@/server/db/fixture-seed";
import { replaceNormalizedWorld } from "@/server/db/relational-sync";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for db:reset-demo.");
  process.exit(1);
}
if (runtimeConfig().mode !== "fixture") {
  console.error("DEMO_RESET_FIXTURE_ONLY:Refusing demo reset when a non-fixture provider is selected. This command is limited to the fixture merchant and an isolated local database.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
const world = createDemoWorld(DEMO_MERCHANT_ID, capabilityStatus());
try {
  await sql.begin(async (tx) => {
    await replaceNormalizedWorld(tx, world);
    await tx`delete from recovery_state where workspace_id = ${world.workspaceId || world.merchant.id}`;
    await tx`
      insert into recovery_state (workspace_id, merchant_id, payload, updated_at)
      values (${world.workspaceId || world.merchant.id}, ${world.merchant.id}, ${JSON.stringify(world)}::jsonb, now())
    `;
  });
  console.log("Reset only the Northstar Office demo snapshot.");
} finally {
  await sql.end({ timeout: 5 });
}
