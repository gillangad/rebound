import { requestRepository, sessionError, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const { repository, session } = requestRepository(request);
  try {
    await repository.resetDemo();
    return sessionJson({ ok: true, message: "Fresh demo workspace restored.", bootstrap: await repository.bootstrap() }, session);
  } catch (error) {
    return sessionError(error, session);
  }
}
