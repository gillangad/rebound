import { z } from "zod";
import { requestRepository, sessionError, sessionJson, readJson } from "@/app/api/_lib";

export const runtime = "nodejs";
const policySchema = z.object({ reviewFirst: z.boolean(), allowedChannels: z.array(z.literal("email")).max(1), contactStartHour: z.number().int().min(0).max(23), contactEndHour: z.number().int().min(1).max(24), timezone: z.string().min(1).max(80), maxAttempts: z.number().int().min(1).max(10), minimumSpacingHours: z.number().int().min(1).max(720), discountsAllowed: z.boolean(), incidentSuppression: z.boolean() });

export async function PATCH(request: Request) {
  const { repository, session } = requestRepository(request);
  try { return sessionJson(await repository.updatePolicy(await readJson(request, policySchema)), session); } catch (error) { return sessionError(error, session); }
}
