import { describe, expect, it } from "vitest";
import { JOB_NAMES, jobNameForKind, payloadForJob } from "@/server/jobs/queue";

describe("durable job routing", () => {
  it("maps every application job mirror to a pg-boss queue", () => {
    expect(jobNameForKind("send_email")).toBe(JOB_NAMES.sendEmail);
    expect(jobNameForKind("revalidate_incident")).toBe(JOB_NAMES.revalidateIncident);
    expect(jobNameForKind("retry_integration")).toBe(JOB_NAMES.retryIntegration);
  });

  it("keeps queue payloads bounded to identifiers and idempotency", () => {
    expect(payloadForJob({ id: "job", merchantId: "11111111-1111-4111-8111-111111111111", kind: "investigate_case", idempotencyKey: "case:1", status: "queued", caseId: "40000000-0000-4000-8000-000000000001", attempts: 0 })).toEqual({ merchantId: "11111111-1111-4111-8111-111111111111", caseId: "40000000-0000-4000-8000-000000000001", proposalId: undefined, batchRunId: undefined, idempotencyKey: "case:1" });
  });
});
