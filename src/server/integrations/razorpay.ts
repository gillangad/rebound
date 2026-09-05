import Razorpay from "razorpay";
import type { PaymentLink } from "@/shared/types";
import { assertPaymentCredentials, runtimeConfig } from "@/server/config";

export interface CreatePaymentLinkInput {
  amount: number;
  currency: string;
  referenceId: string;
  description: string;
  customer: { name: string; email: string };
  acceptPartial: boolean;
}

export interface RazorpayLinkAdapter {
  mode: "fixture" | "live";
  createPaymentLink(input: CreatePaymentLinkInput): Promise<{ providerLinkId: string; shortUrl: string; status: string }>;
  fetchPaymentLink(providerLinkId: string): Promise<{ providerLinkId: string; amount: number; amountPaid: number; status: string }>;
  cancelPaymentLink(providerLinkId: string): Promise<void>;
  fetchDowntime(): Promise<{ available: boolean; provider?: string; method?: string; source: "razorpay" | "fixture" }>;
}

export class FixtureRazorpayAdapter implements RazorpayLinkAdapter {
  mode = "fixture" as const;

  async createPaymentLink(input: CreatePaymentLinkInput) {
    const id = `plink_fixture_${input.referenceId}_${Date.now().toString(36)}`;
    return { providerLinkId: id, shortUrl: `/pay/fixture-pending-${id.slice(-8)}`, status: "created" };
  }

  async fetchPaymentLink(providerLinkId: string) {
    return { providerLinkId, amount: 0, amountPaid: 0, status: "created" };
  }

  async cancelPaymentLink(providerLinkId: string) {
    void providerLinkId;
    return;
  }

  async fetchDowntime() {
    return { available: false, source: "fixture" as const };
  }
}

export class LiveRazorpayAdapter implements RazorpayLinkAdapter {
  mode = "live" as const;
  private readonly client: Razorpay;

  constructor() {
    const config = assertPaymentCredentials();
    this.client = new Razorpay({ key_id: config.razorpayKeyId!, key_secret: config.razorpayKeySecret! });
  }

  async createPaymentLink(input: CreatePaymentLinkInput) {
    const link = await this.client.paymentLink.create({
      amount: input.amount,
      currency: input.currency,
      reference_id: input.referenceId,
      description: input.description,
      accept_partial: input.acceptPartial,
      customer: input.customer,
      notify: { sms: false, email: false }
    });
    return { providerLinkId: String(link.id), shortUrl: String(link.short_url), status: String(link.status) };
  }

  async fetchPaymentLink(providerLinkId: string) {
    const link = await this.client.paymentLink.fetch(providerLinkId);
    return { providerLinkId: String(link.id), amount: Number(link.amount), amountPaid: Number(link.amount_paid || 0), status: String(link.status) };
  }

  async cancelPaymentLink(providerLinkId: string) {
    await this.client.paymentLink.cancel(providerLinkId);
  }

  async fetchDowntime() {
    // The Razorpay downtime endpoint is account-scoped. Keep this boundary explicit so a
    // missing/unsupported endpoint cannot be presented as a confirmed incident.
    const config = runtimeConfig();
    const response = await fetch("https://api.razorpay.com/v1/downtime", { headers: { Authorization: `Basic ${Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString("base64")}` }, cache: "no-store" });
    if (!response.ok) return { available: false, source: "razorpay" as const };
    const payload = await response.json() as { downtime?: boolean; provider?: string; method?: string };
    return { available: Boolean(payload.downtime), provider: payload.provider, method: payload.method, source: "razorpay" as const };
  }
}

export function getRazorpayAdapter(): RazorpayLinkAdapter {
  const config = runtimeConfig();
  if (config.paymentProvider === "fixture") return new FixtureRazorpayAdapter();
  return new LiveRazorpayAdapter();
}

export function isRazorpayTestKey(keyId?: string) {
  return Boolean(keyId?.startsWith("rzp_test_"));
}

export function mapRazorpayLink(link: { id: string; reference_id?: string; amount: number; amount_paid?: number; status: string; short_url: string }, base: Omit<PaymentLink, "razorpayLinkId" | "referenceId" | "amount" | "amountPaid" | "status" | "url">): PaymentLink {
  return { ...base, razorpayLinkId: link.id, referenceId: link.reference_id || base.obligationId, amount: link.amount, amountPaid: link.amount_paid || 0, status: link.status as PaymentLink["status"], url: link.short_url };
}
