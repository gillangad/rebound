import { z } from "zod";
import { requestRepository, sessionError, sessionJson, readJson } from "@/app/api/_lib";

export const runtime = "nodejs";
const decisionSchema = z.object({ decision: z.enum(["approve", "reject"]), editedPayload: z.record(z.unknown()).optional(), rationale: z.string().max(500).optional(), expectedCaseVersion: z.number().int().optional() });

export async function POST(request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const { repository, session } = requestRepository(request);
  try {
    const body = await readJson(request, decisionSchema);
    return sessionJson(await repository.decideProposal({ ...body, proposalId: (await params).proposalId }), session);
  } catch (error) { return sessionError(error, session); }
}
