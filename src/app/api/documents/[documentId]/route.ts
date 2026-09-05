import { getRepositoryForPublicToken } from "@/server/db/repository";
import { attachDemoSession } from "@/server/workspace/session";
import { requestRepository, sessionJson } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function GET(request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  const { documentId } = await params;
  const search = new URL(request.url).searchParams;
  const token = search.get("token");
  const caseId = search.get("caseId");
  const scoped = token ? await getRepositoryForPublicToken(token) : undefined;
  const requestScope = !token ? requestRepository(request) : undefined;
  const repository = scoped || requestScope?.repository;
  const session = requestScope?.session;
  if (!repository) return Response.json({ error: { code: "NOT_FOUND", message: "Document is not available." } }, { status: 404 });
  const page = token ? await repository.getCustomerPage(token) : null;
  const scopedCase = caseId ? await repository.getCaseView(caseId) : null;
  const document = page?.document?.id === documentId ? page.document : scopedCase?.documents.find((item) => item.id === documentId);
  if (!token && !scopedCase) return session ? sessionJson({ error: { code: "TOKEN_REQUIRED", message: "A customer recovery token or scoped merchant case is required to preview this document." } }, session, { status: 403 }) : Response.json({ error: { code: "TOKEN_REQUIRED", message: "A customer recovery token or scoped merchant case is required to preview this document." } }, { status: 403 });
  if (!document || (token && document.permission !== "approved_customer_share")) return session ? sessionJson({ error: { code: "NOT_FOUND", message: "Document is not available." } }, session, { status: 404 }) : Response.json({ error: { code: "NOT_FOUND", message: "Document is not available." } }, { status: 404 });
  const response = new Response(document.extractedText, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `inline; filename="${document.name.replaceAll('"', "")}.txt"` } });
  return session ? attachDemoSession(response, session) : response;
}
