import "@/server/load-env";
import { startRecoveryWorker } from "@/server/jobs/worker";

try {
  const boss = await startRecoveryWorker();
  const shutdown = async () => { await boss.stop({ graceful: true }); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
