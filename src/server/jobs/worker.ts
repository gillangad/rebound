import { PgBoss } from "pg-boss";
import { runtimeConfig } from "@/server/config";
import { getRepository } from "@/server/db/repository";
import { JOB_NAMES, jobNameForKind, payloadForJob, recoveryJobSchema, type RecoveryJobPayload } from "@/server/jobs/queue";
import type { RecoveryRepository } from "@/server/db/repository";

export async function startRecoveryWorker() {
  const config = runtimeConfig();
  if (!config.databaseUrl) throw new Error("DATABASE_REQUIRED:Start PostgreSQL before starting the persistent worker. Fixture web preview without PostgreSQL is intentionally in-process only.");
  const boss = new PgBoss({ connectionString: config.databaseUrl });
  await boss.start();
  for (const name of Object.values(JOB_NAMES)) await boss.createQueue(name);

  // The unscoped repository is used only to enumerate tenant snapshots. Every
  // mutation is then routed through the merchant-scoped repository so a job
  // can never hydrate or persist another workspace's aggregate.
  const repository = getRepository();
  const repositoryFor = (payload: Pick<RecoveryJobPayload, "merchantId">): RecoveryRepository => getRepository({ merchantId: payload.merchantId });
  for (const job of await repository.jobs()) {
    if (job.status === "running") await repositoryFor({ merchantId: job.merchantId }).markJob(job.idempotencyKey, "queued", "Recovered after a worker restart.");
  }

  let queueTail = Promise.resolve();
  const serialize = async <T>(task: () => Promise<T>) => {
    const previous = queueTail;
    let release!: () => void;
    queueTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await task(); } finally { release(); }
  };

  const work = async (jobs: Array<{ data: unknown }>, handler: (payload: RecoveryJobPayload, scoped: RecoveryRepository) => Promise<void>) => serialize(async () => {
    for (const job of jobs) {
      const payload = recoveryJobSchema.parse(job.data);
      const scoped = repositoryFor(payload);
      const mirror = (await scoped.jobs()).find((item) => item.idempotencyKey === payload.idempotencyKey);
      if (mirror?.status === "completed" || mirror?.status === "cancelled") continue;
      await scoped.markJob(payload.idempotencyKey, "running");
      try {
        await handler(payload, scoped);
        // A policy-gated handler may requeue the same mirror job for a later
        // contact window. A successful proposal can also cancel its old
        // sibling jobs. Preserve those deliberate states.
        const latest = (await scoped.jobs()).find((item) => item.idempotencyKey === payload.idempotencyKey);
        if (latest?.status === "queued") continue;
        if (latest?.status === "cancelled" && payload.proposalId) {
          const proposal = (await scoped.bootstrap()).proposals.find((item) => item.id === payload.proposalId);
          if (proposal?.status !== "executed") continue;
        }
        await scoped.markJob(payload.idempotencyKey, "completed");
      } catch (error) {
        await scoped.markJob(payload.idempotencyKey, "failed", error instanceof Error ? error.message : "Worker job failed");
        throw error;
      }
    }
  });

  const executeApprovedProposal = async (payload: RecoveryJobPayload, scoped: RecoveryRepository) => {
    if (!payload.proposalId) return;
    const proposal = (await scoped.bootstrap()).proposals.find((item) => item.id === payload.proposalId);
    if (!proposal || proposal.status === "executed") return;
    if (proposal.status !== "approved") {
      await scoped.markJob(payload.idempotencyKey, "cancelled", "Waiting for merchant approval.");
      return;
    }
    await scoped.decideProposal({ proposalId: proposal.id, decision: "approve" });
  };

  const investigate = async (payload: RecoveryJobPayload, scoped: RecoveryRepository) => {
    if (!payload.caseId) throw new Error("CASE_ID_REQUIRED:Investigation jobs must be scoped to a case.");
    try {
      await scoped.investigateCase(payload.caseId, "explicit_investigation");
      if (payload.batchRunId) await scoped.completeBatchCase(payload.batchRunId, payload.caseId);
    } catch (error) {
      if (payload.batchRunId) await scoped.completeBatchCase(payload.batchRunId, payload.caseId, error instanceof Error ? error.message : "Investigation failed");
      throw error;
    }
  };

  const retryIntegration = async (payload: RecoveryJobPayload, scoped: RecoveryRepository) => {
    if (payload.proposalId) return executeApprovedProposal(payload, scoped);
    if (payload.caseId) return scoped.syncCaseEvidence(payload.caseId);
    throw new Error("INTEGRATION_SCOPE_REQUIRED:Retry jobs must include a case or proposal.");
  };

  await boss.work(JOB_NAMES.ingestSignal, { localConcurrency: 1 }, (jobs) => work(jobs, async (_payload, scoped) => scoped.reconcileSignals()));
  await boss.work(JOB_NAMES.investigateCase, { localConcurrency: 1 }, (jobs) => work(jobs, investigate));
  await boss.work(JOB_NAMES.executeProposal, { localConcurrency: 1 }, (jobs) => work(jobs, executeApprovedProposal));
  await boss.work(JOB_NAMES.sendEmail, { localConcurrency: 1 }, (jobs) => work(jobs, executeApprovedProposal));
  await boss.work(JOB_NAMES.paymentLink, { localConcurrency: 1 }, (jobs) => work(jobs, executeApprovedProposal));
  await boss.work(JOB_NAMES.recheckPromise, { localConcurrency: 1 }, (jobs) => work(jobs, async (payload, scoped) => {
    if (!payload.caseId) throw new Error("CASE_ID_REQUIRED:Promise rechecks must be scoped to a case.");
    await scoped.investigateCase(payload.caseId, "changed_circumstance");
  }));
  await boss.work(JOB_NAMES.detectIncident, { localConcurrency: 1 }, (jobs) => work(jobs, async (payload, scoped) => {
    await scoped.reconcileSignals();
    await scoped.detectIncidents();
    if (payload.caseId) await scoped.syncCaseEvidence(payload.caseId);
  }));
  await boss.work(JOB_NAMES.revalidateIncident, { localConcurrency: 1 }, (jobs) => work(jobs, async (payload, scoped) => {
    if (payload.caseId) await scoped.investigateCase(payload.caseId, "changed_circumstance");
    else if (payload.incidentId) await scoped.resolveIncident(payload.incidentId);
  }));
  await boss.work(JOB_NAMES.connectorSync, { localConcurrency: 1 }, (jobs) => work(jobs, async (payload, scoped) => {
    if (payload.caseId) await scoped.syncCaseEvidence(payload.caseId);
    else await scoped.reconcileSignals();
  }));
  await boss.work(JOB_NAMES.retryIntegration, { localConcurrency: 1 }, (jobs) => work(jobs, retryIntegration));

  let scheduling = false;
  const enqueuePending = async () => serialize(async () => {
    if (scheduling) return;
    scheduling = true;
    try {
      for (const job of (await repository.jobs()).filter((item) => item.status === "queued")) {
        await boss.send(jobNameForKind(job.kind), payloadForJob(job), { startAfter: job.runAfter ? new Date(job.runAfter) : undefined, retryLimit: 3, retryDelay: 30, retryBackoff: true, singletonKey: `${job.merchantId}:${job.idempotencyKey}` });
      }
    } finally {
      scheduling = false;
    }
  });
  await enqueuePending();
  const scheduler = setInterval(() => { void enqueuePending().catch((error) => console.error(error instanceof Error ? error.message : error)); }, 2500);
  scheduler.unref();
  console.log(`Recovery worker running with providers agent=${config.agentProvider}, evidence=${config.evidenceProvider}, payment=${config.paymentProvider}, storage=${config.storageProvider}.`);
  return boss;
}
