import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ incidentId: string }> }) {
  const { repository, session } = requestRepository(request);
  try { return sessionJson(await repository.resolveIncident((await params).incidentId), session); } catch (error) { return sessionError(error, session); }
}
