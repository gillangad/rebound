import { PgBoss } from "pg-boss";
import { z } from "zod";
import { runtimeConfig } from "@/server/config";
import type { JobRecord } from "@/shared/types";

export const JOB_NAMES = {
  ingestSignal: "recovery.ingest-signal",
  investigateCase: "recovery.investigate-case",
  executeProposal: "recovery.execute-proposal",
  sendEmail: "recovery.send-email",
  paymentLink: "recovery.payment-link",
  recheckPromise: "recovery.recheck-promise",
  detectIncident: "recovery.detect-incident",
  revalidateIncident: "recovery.revalidate-incident",
  connectorSync: "recovery.connector-sync",
  retryIntegration: "recovery.retry-integration"
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export interface RecoveryJobPayload {
  merchantId: string;
  caseId?: string;
  proposalId?: string;
  incidentId?: string;
  batchRunId?: string;
  idempotencyKey: string;
}

export const recoveryJobSchema = z.object({
  merchantId: z.string().uuid(),
  caseId: z.string().uuid().optional(),
  proposalId: z.string().uuid().optional(),
  incidentId: z.string().uuid().optional(),
  batchRunId: z.string().uuid().optional(),
  idempotencyKey: z.string().min(1)
});

export function jobNameForKind(kind: JobRecord["kind"]): JobName {
  const names: Record<JobRecord["kind"], JobName> = {
    ingest_signal: JOB_NAMES.ingestSignal,
    investigate_case: JOB_NAMES.investigateCase,
    execute_proposal: JOB_NAMES.executeProposal,
    send_email: JOB_NAMES.sendEmail,
    payment_link: JOB_NAMES.paymentLink,
    recheck_promise: JOB_NAMES.recheckPromise,
    detect_incident: JOB_NAMES.detectIncident,
    revalidate_incident: JOB_NAMES.revalidateIncident,
    connector_sync: JOB_NAMES.connectorSync,
    retry_integration: JOB_NAMES.retryIntegration
  };
  return names[kind];
}

export function payloadForJob(job: JobRecord): RecoveryJobPayload {
  return { merchantId: job.merchantId, caseId: job.caseId, proposalId: job.proposalId, batchRunId: job.batchRunId, idempotencyKey: job.idempotencyKey };
}

export class DurableJobQueue {
  private boss?: PgBoss;

  async start() {
    const config = runtimeConfig();
    if (!config.databaseUrl) throw new Error("DATABASE_REQUIRED:pg-boss requires DATABASE_URL.");
    this.boss = new PgBoss({ connectionString: config.databaseUrl });
    await this.boss.start();
    for (const name of Object.values(JOB_NAMES)) await this.boss.createQueue(name);
    return this;
  }

  async send(name: JobName, payload: RecoveryJobPayload, options?: { startAfter?: Date; retryLimit?: number; singletonKey?: string }) {
    if (!this.boss) throw new Error("QUEUE_NOT_STARTED");
    return this.boss.send(name, payload, {
      startAfter: options?.startAfter,
      retryLimit: options?.retryLimit ?? 3,
      retryDelay: 30,
      retryBackoff: true,
      singletonKey: options?.singletonKey || payload.idempotencyKey
    });
  }

  async stop() {
    await this.boss?.stop({ graceful: true });
  }
}
