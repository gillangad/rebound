import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const filter = new URL(request.url).searchParams.get("q") || undefined;
  const { repository, session } = requestRepository(request);
  try { return sessionJson({ audit: await repository.audit(filter) }, session); } catch (error) { return sessionError(error, session); }
}
