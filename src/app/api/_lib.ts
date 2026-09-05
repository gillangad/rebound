import { z } from "zod";
import { getRepository, RepositoryError, type RecoveryRepository } from "@/server/db/repository";
import { attachDemoSession, getDemoSession, type DemoSession } from "@/server/workspace/session";

export function jsonError(error: unknown) {
  if (error instanceof RepositoryError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "STALE_VERSION" || error.code === "PROVIDER_MISMATCH" ? 409 : error.code === "DATABASE_REQUIRED" || error.code === "WORKSPACE_REQUIRED" || error.code === "AGENT_PROVIDER_FAILED" ? 503 : 422;
    return Response.json({ error: { code: error.code, message: error.message, details: error.details } }, { status });
  }
  const message = error instanceof Error ? error.message : "Unexpected server error";
  return Response.json({ error: { code: "INTERNAL_ERROR", message } }, { status: 500 });
}

export function requestRepository(request: Request): { repository: RecoveryRepository; session: DemoSession } {
  const session = getDemoSession(request);
  return { repository: getRepository({ workspaceId: session.workspaceId }), session };
}

export function sessionJson(value: unknown, session: DemoSession, init?: ResponseInit) {
  return attachDemoSession(Response.json(value, init), session);
}

export function sessionError(error: unknown, session: DemoSession) {
  return attachDemoSession(jsonError(error), session);
}

export async function readJson<T extends z.ZodTypeAny>(request: Request, schema: T): Promise<z.infer<T>> {
  const body: unknown = await request.json();
  return schema.parse(body);
}
