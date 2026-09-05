import { describe, expect, it } from "vitest";
import { EVALUATION_DATASET_VERSION, evaluationDataset } from "@/server/evaluation/dataset";
import { runFixtureEvaluation } from "@/server/evaluation/runner";

describe("deterministic evaluation", () => {
  it("runs the independent 30-case dataset with explicit denominators and fixture proof", () => {
    const report = runFixtureEvaluation();
    expect(evaluationDataset).toHaveLength(30);
    expect(report.datasetVersion).toBe(EVALUATION_DATASET_VERSION);
    expect(report.metrics.totalCases).toBe(30);
    expect(evaluationDataset.every((record) => record.recoveryCase.blocker === "no_response" && record.recoveryCase.confidence === 0)).toBe(true);
    expect(evaluationDataset.filter((record) => record.expected.document).every((record) => record.documents.some((document) => document.name === record.expected.document && document.permission === "approved_customer_share"))).toBe(true);
    expect(report.metrics.blockerClassification.denominator).toBe(26);
    expect(report.metrics.interventionAccuracy).toEqual({ correct: 30, denominator: 30 });
    expect(report.metrics.documentMatches).toEqual({ correct: 4, denominator: 4 });
    expect(report.metrics.suppressionsEscalations).toEqual({ correct: 22, denominator: 22 });
    expect(report.metrics.unnecessaryContactsAvoided).toEqual({ correct: 22, denominator: 22 });
    expect(report.metrics.unresolvedOrErrors.denominator).toBe(30);
    expect(report.integrationProof).toEqual({ mode: "fixture", connectorRetrievedMessages: 0, connectorRetrievedDocuments: 0, providerSentEmails: 0, razorpayCreatedLinks: 0, signedRazorpayPayments: 0, verifiedCollectedAmount: 0, apiConfirmed: false });
    expect(report.results.every((result) => result.caseId && result.status)).toBe(true);
  });
});
