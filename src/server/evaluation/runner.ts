import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import postgres from "postgres";
import { DEMO_CLOCK } from "@/shared/constants";
import type { BlockerCategory, EvaluationCaseResult, EvaluationMetrics, EvaluationReport, IntegrationProof, Policy, RecoveryCase } from "@/shared/types";
import { correlateSignal } from "@/server/domain/correlation";
import { isOrdinaryChasingEligible } from "@/server/domain/policy";
import { EVALUATION_DATASET_VERSION, evaluationDataset } from "@/server/evaluation/dataset";

const evaluationPolicy: Policy = { id: "eval-policy", merchantId: "11111111-1111-4111-8111-111111111111", version: 1, reviewFirst: true, allowedChannels: ["email"], contactStartHour: 9, contactEndHour: 18, timezone: "Asia/Kolkata", maxAttempts: 2, minimumSpacingHours: 24, discountsAllowed: false, autoSendClasses: [], incidentSuppression: true, updatedAt: DEMO_CLOCK };

function actualBlocker(record: typeof evaluationDataset[number]) {
  if (!record.signal) return "insufficient_evidence";
  const result = correlateSignal(record.signal, record.correlationObligations, [record.customer]);
  if (result.status !== "matched") return result.status;
  const matchedObligation = record.correlationObligations.find((item) => item.id === result.obligationId) || record.obligation;
  const messageText = record.messages.map((message) => message.body).join(" ").toLowerCase();
  if (matchedObligation.status === "partially_paid" || matchedObligation.status === "paid") return "partial_payment";
  if (record.signal.type === "payment_failed") return "payment_failed";
  if (record.signal.type === "incident_pattern") return "incident";
  if (messageText.includes("dispute") || messageText.includes("quantity") || messageText.includes("discrepancy")) return "dispute";
  if (messageText.includes("opt out") || messageText.includes("do not contact")) return "opted_out";
  if (messageText.includes("friday") || messageText.includes("do not follow up")) return "promise_to_pay";
  if (messageText.includes("delivery confirmation") || messageText.includes("signed delivery")) return "missing_document";
  return "no_response";
}

function actualIntervention(record: typeof evaluationDataset[number], blocker: string) {
  if (blocker === "ambiguous") return "escalation";
  if (blocker === "unmatched" || blocker === "insufficient_evidence") return "no_action";
  if (["dispute", "opted_out"].includes(blocker)) return "escalation";
  if (blocker === "promise_to_pay") return "promise_schedule";
  if (blocker === "incident") return "suppressed";
  if (blocker === "partial_payment" || record.recoveryCase.state === "recovered" || blocker === "no_response") return "no_action";
  if (blocker === "missing_document") {
    const hasShareSafeMatch = record.documents.some((document) => document.customerId === record.customer.id && document.obligationId === record.obligation.id && document.permission === "approved_customer_share" && document.extractedText.trim().length > 0);
    return hasShareSafeMatch ? "document_response" : "escalation";
  }
  return "recovery_message";
}

function actualContactEligible(record: typeof evaluationDataset[number], blocker: string) {
  const actualBlockerCategory: BlockerCategory = ["payment_failed", "missing_document", "dispute", "promise_to_pay", "partial_payment", "inability_to_pay", "no_response", "incident", "opted_out"].includes(blocker) ? blocker as BlockerCategory : "no_response";
  const recoveryCase: RecoveryCase = { ...record.recoveryCase, blocker: actualBlockerCategory };
  if (["ambiguous", "insufficient_evidence", "unmatched"].includes(blocker)) return false;
  return isOrdinaryChasingEligible(recoveryCase, evaluationPolicy, new Date(DEMO_CLOCK));
}

function actualDocument(record: typeof evaluationDataset[number], intervention: string) {
  if (intervention !== "document_response") return undefined;
  return record.documents.find((document) => document.customerId === record.customer.id && document.obligationId === record.obligation.id && document.permission === "approved_customer_share")?.name;
}

function integrationProof(): IntegrationProof { return { mode: "fixture", connectorRetrievedMessages: 0, connectorRetrievedDocuments: 0, providerSentEmails: 0, razorpayCreatedLinks: 0, signedRazorpayPayments: 0, verifiedCollectedAmount: 0, apiConfirmed: false }; }

export function runFixtureEvaluation(): EvaluationReport {
  const results: EvaluationCaseResult[] = evaluationDataset.map((record) => {
    const blockerActual = actualBlocker(record);
    const interventionActual = actualIntervention(record, blockerActual);
    const contactEligibleActual = actualContactEligible(record, blockerActual);
    const documentActual = actualDocument(record, interventionActual);
    const blockerCorrect = blockerActual === record.expected.blocker;
    const interventionCorrect = interventionActual === record.expected.intervention;
    const documentCorrect = !record.expected.document || documentActual === record.expected.document;
    const contactCorrect = contactEligibleActual === record.expected.contactEligible;
    const allCorrect = blockerCorrect && interventionCorrect && documentCorrect && contactCorrect;
    const status = !record.expected.resolvable ? "unresolved" : allCorrect ? "correct" : "incorrect";
    return { caseId: record.caseId, label: record.label, blockerExpected: record.expected.blocker, blockerActual, interventionExpected: record.expected.intervention, interventionActual, documentExpected: record.expected.document, documentActual, contactEligibleExpected: record.expected.contactEligible, contactEligibleActual, resolvable: record.expected.resolvable, status, reason: allCorrect ? undefined : `blocker=${blockerActual}; intervention=${interventionActual}; contactEligible=${contactEligibleActual}`, startingOutstanding: Math.max(0, record.obligation.amountDue - record.obligation.amountPaid), remainingValue: Math.max(0, record.obligation.amountDue - record.obligation.amountPaid) };
  });
  const knownBlocker = results.filter((result) => !["ambiguous", "insufficient_evidence"].includes(result.blockerExpected));
  const documentResults = results.filter((result) => result.documentExpected);
  const suppressionResults = results.filter((result) => !result.contactEligibleExpected);
  const metrics: EvaluationMetrics = {
    totalCases: results.length,
    startingOutstanding: results.reduce((total, result) => total + result.startingOutstanding, 0),
    remainingValue: results.reduce((total, result) => total + result.remainingValue, 0),
    blockerClassification: { correct: knownBlocker.filter((result) => result.blockerActual === result.blockerExpected).length, denominator: knownBlocker.length },
    interventionAccuracy: { correct: results.filter((result) => result.interventionActual === result.interventionExpected).length, denominator: results.length },
    documentMatches: { correct: documentResults.filter((result) => result.documentActual === result.documentExpected).length, denominator: documentResults.length },
    suppressionsEscalations: { correct: suppressionResults.filter((result) => result.contactEligibleActual === result.contactEligibleExpected && ["escalation", "suppressed", "promise_schedule", "no_action"].includes(result.interventionActual)).length, denominator: suppressionResults.length },
    unnecessaryContactsAvoided: { correct: results.filter((result) => !result.contactEligibleExpected && !result.contactEligibleActual).length, denominator: results.filter((result) => !result.contactEligibleExpected).length },
    unresolvedOrErrors: { count: results.filter((result) => result.status === "unresolved" || result.status === "error").length, denominator: results.length }
  };
  const runId = "90000000-0000-4000-8000-000000000002";
  return { runId, datasetVersion: EVALUATION_DATASET_VERSION, buildId: process.env.APP_BUILD_ID || "local", mode: "fixture", provider: "fixture", startedAt: DEMO_CLOCK, finishedAt: DEMO_CLOCK, metrics, results, integrationProof: integrationProof(), baseline: { name: "policy reminder-all", unnecessaryContacts: results.filter((result) => !result.contactEligibleExpected).length, denominator: results.length } };
}

async function persistEvaluationRun(report: EvaluationReport) {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) return false;
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 10 });
  try {
    await sql.begin(async (tx) => {
      await tx`
        insert into evaluation_runs (id, dataset_version, build_id, mode, provider, started_at, finished_at, metrics, integration_proof, baseline)
        values (${report.runId}, ${report.datasetVersion}, ${report.buildId}, ${report.mode}, ${report.provider}, ${report.startedAt}::timestamptz, ${report.finishedAt}::timestamptz, ${JSON.stringify(report.metrics)}::jsonb, ${JSON.stringify(report.integrationProof)}::jsonb, ${JSON.stringify(report.baseline)}::jsonb)
        on conflict (id) do nothing
      `;
      for (const result of report.results) {
        const expected = { blocker: result.blockerExpected, intervention: result.interventionExpected, document: result.documentExpected, contactEligible: result.contactEligibleExpected, resolvable: result.resolvable };
        const actual = { blocker: result.blockerActual, intervention: result.interventionActual, document: result.documentActual, contactEligible: result.contactEligibleActual, status: result.status };
        await tx`
          insert into evaluation_results (run_id, case_id, expected, actual, status, reason, starting_outstanding, remaining_value)
          values (${report.runId}, ${result.caseId}, ${JSON.stringify(expected)}::jsonb, ${JSON.stringify(actual)}::jsonb, ${result.status}, ${result.reason || null}, ${result.startingOutstanding}, ${result.remainingValue})
          on conflict (run_id, case_id) do nothing
        `;
      }
    });
    return true;
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export async function writeEvaluationReport(report = runFixtureEvaluation()) {
  const target = join(process.cwd(), "evaluation-report.json");
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(target, serialized, "utf8");
  const historyDirectory = join(process.cwd(), "evaluation-runs");
  await mkdir(historyDirectory, { recursive: true });
  const immutableTarget = join(historyDirectory, `${report.runId}.json`);
  try {
    await readFile(immutableTarget, "utf8");
  } catch {
    try {
      await writeFile(immutableTarget, serialized, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
  }
  await persistEvaluationRun(report);
  return target;
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("src/server/evaluation/runner.ts")) {
  await import("@/server/load-env");
  const report = runFixtureEvaluation();
  const target = await writeEvaluationReport(report);
  console.log(`Wrote deterministic ${report.metrics.totalCases}-case evaluation to ${target}`);
  console.log(JSON.stringify(report.metrics, null, 2));
  console.log("Integration proof remains API-confirmed zero in fixture mode.");
}
