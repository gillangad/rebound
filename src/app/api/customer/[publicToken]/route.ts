import { getRepositoryForPublicToken } from "@/server/db/repository";

export const runtime = "nodejs";

export async function GET(_request: Request, { params }: { params: Promise<{ publicToken: string }> }) {
  const repository = await getRepositoryForPublicToken((await params).publicToken);
  const data = await repository?.getCustomerPage((await params).publicToken);
  if (!data) return Response.json({ error: { code: "NOT_FOUND", message: "This recovery link is unavailable or revoked." } }, { status: 404 });
  return Response.json(data);
}
