import { z } from "zod";
import { requestRepository, sessionError, sessionJson, readJson } from "@/app/api/_lib";

export const runtime = "nodejs";
const pauseSchema = z.object({ reason: z.string().min(1).max(300), pauseUntil: z.string().datetime().optional(), resume: z.boolean().optional() });

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { repository, session } = requestRepository(request);
  try {
    const body = await readJson(request, pauseSchema);
    const caseId = (await params).caseId;
    return sessionJson({ case: body.resume ? await repository.resumeCase(caseId) : await repository.pauseCase(caseId, body.reason, body.pauseUntil) }, session);
  } catch (error) { return sessionError(error, session); }
}
