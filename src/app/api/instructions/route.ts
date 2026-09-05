import { instructionSchema } from "@/server/agent/schemas";
import { requestRepository, sessionError, sessionJson, readJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { repository, session } = requestRepository(request);
  try { const body = await readJson(request, instructionSchema); return sessionJson(await repository.submitInstruction(body.caseId, body.instruction), session); } catch (error) { return sessionError(error, session); }
}
