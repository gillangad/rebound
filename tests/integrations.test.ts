import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleDriveAdapter, GoogleEmailAdapter } from "@/server/integrations/google";
import { MemoryRepository } from "@/server/db/repository";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Google connector boundaries", () => {
  it("searches Gmail metadata and reads the full MIME message with provenance", async () => {
    const body = Buffer.from("The signed delivery confirmation is attached.").toString("base64url");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ messages: [{ id: "gmail-message-1" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "gmail-message-1",
        threadId: "gmail-thread-1",
        internalDate: "1788509400000",
        payload: {
          headers: [
            { name: "Subject", value: "Signed delivery confirmation" },
            { name: "From", value: "priya@example.com" },
            { name: "To", value: "collections@example.com" }
          ],
          parts: [{ mimeType: "text/plain", body: { data: body } }]
        }
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const messages = await new GoogleEmailAdapter("encrypted-test-token").searchThreads("from:priya@example.com delivery");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ providerId: "gmail-message-1", threadId: "gmail-thread-1", subject: "Signed delivery confirmation", from: "priya@example.com", to: ["collections@example.com"], body: "The signed delivery confirmation is attached.", providerMode: "live" });
    expect(messages[0].providerUrl).toContain("gmail-message-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("format=full");
  });

  it("searches Drive metadata and reads readable native text through the provider", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ files: [{ id: "drive-doc-1", name: "NW delivery confirmation", mimeType: "application/vnd.google-apps.document", webViewLink: "https://drive.google.com/file/d/drive-doc-1/view", modifiedTime: "2026-09-04T08:00:00.000Z" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: "drive-doc-1", name: "NW delivery confirmation", mimeType: "application/vnd.google-apps.document", webViewLink: "https://drive.google.com/file/d/drive-doc-1/view" }), { status: 200 }))
      .mockResolvedValueOnce(new Response("Invoice: NSO-INV-2048\nCustomer: City Interiors", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new GoogleDriveAdapter("encrypted-test-token");
    const candidates = await adapter.searchDocuments("NSO-INV-2048");
    const document = await adapter.readDocument(candidates[0].providerId);
    expect(candidates[0]).toMatchObject({ providerId: "drive-doc-1", providerMode: "live", name: "NW delivery confirmation" });
    expect(document.extractedText).toContain("NSO-INV-2048");
    expect(document.sourceUrl).toContain("drive-doc-1");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(String(fetchMock.mock.calls[2][0])).toContain("/export?");
  });

  it("routes a configured Google evidence investigation through both provider adapters", async () => {
    vi.stubEnv("AGENT_PROVIDER", "fixture");
    vi.stubEnv("EVIDENCE_PROVIDER", "google");
    vi.stubEnv("PAYMENT_PROVIDER", "fixture");
    vi.stubEnv("GOOGLE_ACCESS_TOKEN", "server-side-test-token");
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes("gmail.googleapis.com") && url.includes("/messages?q=")) return new Response(JSON.stringify({ messages: [{ id: "gmail-atelier-1" }] }), { status: 200 });
      if (url.includes("gmail.googleapis.com") && url.includes("/messages/gmail-atelier-1")) return new Response(JSON.stringify({ id: "gmail-atelier-1", threadId: "gmail-thread-atelier-1", internalDate: "1788509400000", payload: { headers: [{ name: "Subject", value: "Delivery confirmation needed for NSO-INV-2048" }, { name: "From", value: "priya@atelierworks.example" }, { name: "To", value: "collections@northstar.example" }], body: { data: Buffer.from("Finance needs signed delivery confirmation for NSO-INV-2048 and NSO-PO-8831.").toString("base64url") } } }), { status: 200 });
      if (url.includes("drive/v3/files?") && !url.includes("/export?")) return new Response(JSON.stringify({ files: [{ id: "drive-atelier-1", name: "NW-DELIVERY-ATELIER-30-DESKS", mimeType: "application/vnd.google-apps.document", webViewLink: "https://drive.google.com/file/d/drive-atelier-1/view" }] }), { status: 200 });
      if (url.includes("/export?")) return new Response("Customer: City Interiors\nInvoice: NSO-INV-2048\nPurchase order: NSO-PO-8831\nSigned delivery confirmation: 30 desks received.", { status: 200 });
      if (url.includes("drive/v3/files/drive-atelier-1")) return new Response(JSON.stringify({ id: "drive-atelier-1", name: "NW-DELIVERY-ATELIER-30-DESKS", mimeType: "application/vnd.google-apps.document", webViewLink: "https://drive.google.com/file/d/drive-atelier-1/view" }), { status: 200 });
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const repo = new MemoryRepository(undefined, undefined, { fixtureAsync: false });
    const atelier = repo.world.cases.find((item) => repo.world.customers.find((customer) => customer.id === item.customerId)?.displayName === "City Interiors")!;
    await repo.investigateCase(atelier.id);
    expect(repo.world.messages.find((item) => item.caseId === atelier.id)).toMatchObject({ providerMode: "live", providerId: "gmail-atelier-1" });
    expect(repo.world.documents.find((item) => item.obligationId === atelier.obligationId)).toMatchObject({ providerMode: "live", providerId: "drive-atelier-1" });
    expect(repo.world.proposals.find((item) => item.caseId === atelier.id)).toMatchObject({ type: "document_response" });
    expect(repo.world.audit.some((item) => item.eventType === "connector.message.retrieved" && item.provider === "google")).toBe(true);
    expect(repo.world.audit.some((item) => item.eventType === "connector.document.retrieved" && item.provider === "google")).toBe(true);
    expect((await repo.bootstrap()).integrationProof).toMatchObject({ connectorRetrievedMessages: 1, connectorRetrievedDocuments: 1, providerSentEmails: 0, signedRazorpayPayments: 0, verifiedCollectedAmount: 0, apiConfirmed: false });
  });
});
