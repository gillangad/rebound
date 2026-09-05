import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "@/server/db/repository";

describe("webhook verification", () => {
  it("requires the exact raw body HMAC", () => {
    const body = JSON.stringify({ id: "evt_1", event: "payment_link.paid" });
    const signature = createHmac("sha256", "secret").update(body).digest("hex");
    expect(verifyWebhookSignature(body, signature, "secret")).toBe(true);
    expect(verifyWebhookSignature(`${body} `, signature, "secret")).toBe(false);
    expect(verifyWebhookSignature(body, null, "secret")).toBe(false);
  });
});
