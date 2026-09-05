import { getRepositoryForPublicToken } from "@/server/db/repository";
import { jsonError } from "@/app/api/_lib";

export const runtime = "nodejs";

export async function POST(_request: Request, { params }: { params: Promise<{ publicToken: string }> }) {
  try {
    const token = (await params).publicToken;
    const repository = await getRepositoryForPublicToken(token);
    if (!repository) return Response.json({ error: { code: "NOT_FOUND", message: "This recovery link is unavailable or revoked." } }, { status: 404 });
    return Response.json(await repository.verifyFixturePayment(token));
  } catch (error) { return jsonError(error); }
}
