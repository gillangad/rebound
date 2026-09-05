import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { repository, session } = requestRepository(request);
  try { return sessionJson(await repository.bootstrap(), session); } catch (error) { return sessionError(error, session); }
}
