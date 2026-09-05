import { z } from "zod";

export const caseIdSchema = z.object({ caseId: z.string().min(1) });
export const querySchema = z.object({ caseId: z.string().min(1), query: z.string().max(200).optional() });
export const proposalSchema = z.object({
  caseId: z.string().min(1),
  intendedOutcome: z.string().min(1).max(300),
  recipient: z.string().min(1).max(320),
  scope: z.string().min(1).max(300),
  channel: z.enum(["email", "system"]),
  payload: z.record(z.unknown()),
  evidenceIds: z.array(z.string()).max(20),
  uncertainty: z.string().min(1).max(500),
  explanation: z.string().min(1).max(700)
});
export const instructionSchema = z.object({ caseId: z.string().min(1).optional(), instruction: z.string().min(1).max(500) });
