import "@/server/load-env";
import postgres from "postgres";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required for db:migrate. In fixture mode, the web app can run with its explicitly labelled in-process demo store.");
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  const migration = await readFile(join(process.cwd(), "src/server/db/migrations/0000_initial.sql"), "utf8");
  await sql.unsafe(migration);
  console.log("Applied 0000_initial.sql");
} finally {
  await sql.end({ timeout: 5 });
}
