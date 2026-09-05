import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request, { params }: { params: Promise<{ caseId: string }> }) {
  const { repository, session } = requestRepository(request);
  try { return sessionJson(await repository.investigateCase((await params).caseId), session); } catch (error) { return sessionError(error, session); }
}
