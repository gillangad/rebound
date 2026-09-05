import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const { repository, session } = requestRepository(request);
  try {
    const data = await repository.bootstrap();
    return sessionJson({ mode: data.mode, capabilities: data.capabilities, connectors: data.connectors.map(({ id, type, mode, status, scopes, lastSyncAt }) => ({ id, type, mode, status, scopes, lastSyncAt })) }, session);
  } catch (error) {
    return sessionError(error, session);
  }
}
