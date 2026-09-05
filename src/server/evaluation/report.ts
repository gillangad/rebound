import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvaluationReport } from "@/shared/types";
import { runFixtureEvaluation } from "@/server/evaluation/runner";

export async function readEvaluationReport(): Promise<EvaluationReport> {
  try {
    const value = JSON.parse(await readFile(join(process.cwd(), "evaluation-report.json"), "utf8")) as EvaluationReport;
    if (value.datasetVersion && value.metrics && value.results) return value;
  } catch {
    // The report is a checked-in artifact in normal operation. Computing the
    // same fixture report keeps a fresh checkout usable before regeneration.
  }
  return runFixtureEvaluation();
}
