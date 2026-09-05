import { runtimeConfig } from "@/server/config";
import { getRepositoryForWebhookEvent, verifyWebhookSignature } from "@/server/db/repository";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const config = runtimeConfig();
  const signature = request.headers.get("x-razorpay-signature");
  const secret = config.paymentProvider === "fixture" ? config.fixtureWebhookSecret : config.razorpayWebhookSecret;
  if (!secret || !verifyWebhookSignature(rawBody, signature, secret)) return Response.json({ error: { code: "INVALID_SIGNATURE", message: "Webhook signature verification failed." } }, { status: 401 });
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const eventId = request.headers.get("x-razorpay-event-id") || String(body.id || `payload-${Buffer.from(rawBody).toString("base64url").slice(0, 32)}`);
    const repository = await getRepositoryForWebhookEvent(body);
    if (!repository) return Response.json({ error: { code: "WORKSPACE_NOT_FOUND", message: "The signed webhook did not identify a known tenant payment or payment link." } }, { status: 404 });
    const result = await repository.ingestRazorpayEvent(eventId, body, rawBody);
    return Response.json({ received: true, ...result });
  } catch (error) {
    return Response.json({ error: { code: "WEBHOOK_NOT_PERSISTED", message: error instanceof Error ? error.message : "Webhook could not be persisted" } }, { status: 500 });
  }
}
