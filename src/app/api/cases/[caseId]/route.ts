import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { repository, session } = requestRepository(request);
  try {
    const { caseId } = await params;
    const result = await repository.getCaseView(caseId);
    if (!result) return sessionJson({ error: { code: "NOT_FOUND", message: "Recovery case not found." } }, session, { status: 404 });
    return sessionJson(result, session);
  } catch (error) { return sessionError(error, session); }
}
