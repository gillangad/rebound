import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { ProviderMode } from "@/shared/types";

function encryptionKey() {
  const value = process.env.TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("TOKEN_ENCRYPTION_KEY_REQUIRED:Google connector tokens require a server-side encryption key.");
  return createHash("sha256").update(value).digest();
}

export function encryptToken(token: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptToken(value: string) {
  const [ivValue, tagValue, encryptedValue] = value.split(".");
  if (!ivValue || !tagValue || !encryptedValue) throw new Error("INVALID_TOKEN_ENVELOPE");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedValue, "base64url")), decipher.final()]).toString("utf8");
}

export interface EmailMessage {
  providerId: string;
  threadId: string;
  subject: string;
  from: string;
  to: string[];
  body: string;
  receivedAt: string;
  providerMode: ProviderMode;
  providerUrl?: string;
}

export interface EmailAdapter {
  mode: "fixture" | "live";
  searchThreads(query: string): Promise<EmailMessage[]>;
  getMessage(providerId: string): Promise<EmailMessage>;
  sendApproved(input: { to: string; subject: string; body: string; approvalId: string; threadId?: string }): Promise<{ providerId: string; threadId?: string; sentAt: string; providerMode: ProviderMode }>;
  health(): Promise<{ status: "healthy" | "fixture" | "error"; detail: string }>;
}

type FixtureEmail = {
  providerId: string;
  threadId?: string;
  subject: string;
  from: string;
  to?: string[];
  body: string;
  receivedAt: string;
};

function fixtureEmailMessage(message: FixtureEmail): EmailMessage {
  return {
    providerId: message.providerId,
    threadId: message.threadId || message.providerId,
    subject: message.subject,
    from: message.from,
    to: message.to || ["collections@northstar.example"],
    body: message.body,
    receivedAt: message.receivedAt,
    providerMode: "fixture"
  };
}

export class FixtureEmailAdapter implements EmailAdapter {
  mode = "fixture" as const;
  constructor(private readonly messages: FixtureEmail[]) {}

  async searchThreads(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.messages.filter((message) => terms.every((term) => `${message.subject} ${message.body} ${message.from}`.toLowerCase().includes(term))).map(fixtureEmailMessage);
  }

  async getMessage(providerId: string) {
    const message = this.messages.find((item) => item.providerId === providerId);
    if (!message) throw new Error("GMAIL_MESSAGE_NOT_FOUND");
    return fixtureEmailMessage(message);
  }

  async sendApproved(input: { to: string; subject: string; body: string; approvalId: string; threadId?: string }) {
    if (!input.approvalId) throw new Error("APPROVAL_REQUIRED:Fixture email send requires an approval id.");
    return { providerId: `fixture-outbox-${input.approvalId}`, threadId: input.threadId, sentAt: new Date().toISOString(), providerMode: "fixture" as const };
  }

  async health() { return { status: "fixture" as const, detail: "Demo simulation; outbound messages are stored in the local outbox." }; }
}

function headerValue(headers: Array<{ name: string; value: string }>, name: string) {
  return headers.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || "";
}

function decodeBase64Url(value: string) {
  return Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64").toString("utf8");
}

type MimePart = { body?: { data?: string }; parts?: MimePart[] };

function decodeMimeBody(payload: MimePart): string {
  if (payload.body?.data) return decodeBase64Url(payload.body.data);
  for (const part of payload.parts || []) {
    const value = decodeMimeBody(part);
    if (value) return value;
  }
  return "";
}

type GmailMessagePayload = {
  id: string;
  threadId: string;
  payload?: { headers?: Array<{ name: string; value: string }>; body?: { data?: string }; parts?: MimePart[] };
  internalDate?: string;
};

export class GoogleEmailAdapter implements EmailAdapter {
  mode = "live" as const;
  constructor(private readonly accessToken: string) {}

  async searchThreads(query: string) {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=20`, { headers: { Authorization: `Bearer ${this.accessToken}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`GMAIL_SEARCH_FAILED:${response.status}`);
    const data = await response.json() as { messages?: Array<{ id: string }> };
    return Promise.all((data.messages || []).map((message) => this.getMessage(message.id)));
  }

  async getMessage(providerId: string) {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(providerId)}?format=full`, { headers: { Authorization: `Bearer ${this.accessToken}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`GMAIL_MESSAGE_READ_FAILED:${response.status}`);
    const data = await response.json() as GmailMessagePayload;
    const headers = data.payload?.headers || [];
    const receivedAt = new Date(Number(data.internalDate || 0) || Date.parse(headerValue(headers, "Date")) || Date.now()).toISOString();
    return {
      providerId: data.id,
      threadId: data.threadId || data.id,
      subject: headerValue(headers, "Subject") || "(no subject)",
      from: headerValue(headers, "From"),
      to: headerValue(headers, "To").split(",").map((value) => value.trim()).filter(Boolean),
      body: decodeMimeBody(data.payload || {}),
      receivedAt,
      providerMode: "live" as const,
      providerUrl: `https://mail.google.com/mail/u/0/#inbox/${encodeURIComponent(data.id)}`
    };
  }

  async sendApproved(input: { to: string; subject: string; body: string; approvalId: string; threadId?: string }) {
    if (!input.approvalId) throw new Error("APPROVAL_REQUIRED:Google email send requires an approval id.");
    const headers = [`To: ${input.to}`, `Subject: ${input.subject}`, "Content-Type: text/plain; charset=utf-8", `X-Recovery-Approval-Id: ${input.approvalId}`];
    if (input.threadId) headers.push(`In-Reply-To: <${input.threadId}>`, `References: <${input.threadId}>`);
    const raw = [...headers, "", input.body].join("\r\n");
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", headers: { Authorization: `Bearer ${this.accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify({ raw: Buffer.from(raw).toString("base64url"), threadId: input.threadId }) });
    if (!response.ok) throw new Error(`GMAIL_SEND_FAILED:${response.status}`);
    const data = await response.json() as { id: string; threadId?: string };
    return { providerId: data.id, threadId: data.threadId || input.threadId, sentAt: new Date().toISOString(), providerMode: "live" as const };
  }

  async health() { return { status: "healthy" as const, detail: "Google Email OAuth connection is active." }; }
}

export interface DriveDocument {
  providerId: string;
  name: string;
  mimeType: string;
  sourceUrl: string;
  extractedText?: string;
  providerMode: ProviderMode;
  modifiedAt?: string;
}

export interface DriveAdapter {
  mode: "fixture" | "live";
  searchDocuments(query: string): Promise<DriveDocument[]>;
  readDocument(providerId: string): Promise<DriveDocument & { extractedText: string }>;
  health(): Promise<{ status: "healthy" | "fixture" | "error"; detail: string }>;
}

type FixtureDocument = Omit<DriveDocument, "providerMode"> & { extractedText: string };

export class FixtureDriveAdapter implements DriveAdapter {
  mode = "fixture" as const;
  constructor(private readonly documents: FixtureDocument[]) {}
  async searchDocuments(query: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.documents.filter((doc) => terms.every((term) => `${doc.name} ${doc.extractedText}`.toLowerCase().includes(term))).map((doc) => ({ ...doc, providerMode: "fixture" as const, extractedText: undefined }));
  }
  async readDocument(providerId: string) {
    const doc = this.documents.find((item) => item.providerId === providerId);
    if (!doc) throw new Error("DRIVE_DOCUMENT_NOT_FOUND");
    return { ...doc, providerMode: "fixture" as const };
  }
  async health() { return { status: "fixture" as const, detail: "Demo simulation; document access is limited to seeded matching fixtures." }; }
}

function escapeDriveQuery(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function extractSimplePdfText(bytes: Buffer) {
  const source = bytes.toString("latin1");
  const chunks = [...source.matchAll(/\(([^()]*)\)/g)].map((match) => match[1].replaceAll(/\\([\\()])/g, "$1")).filter((value) => /[A-Za-z0-9]/.test(value));
  const text = chunks.join(" ").replaceAll(/\s+/g, " ").trim();
  if (!text) throw new Error("DRIVE_PDF_EXTRACTION_UNAVAILABLE:Use a Google Doc or text/plain delivery confirmation for live evidence.");
  return text;
}

export class GoogleDriveAdapter implements DriveAdapter {
  mode = "live" as const;
  constructor(private readonly accessToken: string) {}

  async searchDocuments(query: string) {
    const escaped = escapeDriveQuery(query);
    const response = await fetch(`https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(`trashed = false and fullText contains '${escaped}'`)}&pageSize=20&fields=files(id,name,mimeType,webViewLink,modifiedTime)`, { headers: { Authorization: `Bearer ${this.accessToken}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`DRIVE_SEARCH_FAILED:${response.status}`);
    const data = await response.json() as { files?: Array<{ id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string }> };
    return (data.files || []).map((file) => ({ providerId: file.id, name: file.name, mimeType: file.mimeType, sourceUrl: file.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`, providerMode: "live" as const, modifiedAt: file.modifiedTime }));
  }

  async readDocument(providerId: string) {
    const metadataResponse = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerId)}?fields=id,name,mimeType,webViewLink,modifiedTime`, { headers: { Authorization: `Bearer ${this.accessToken}` }, cache: "no-store" });
    if (!metadataResponse.ok) throw new Error(`DRIVE_METADATA_READ_FAILED:${metadataResponse.status}`);
    const file = await metadataResponse.json() as { id: string; name: string; mimeType: string; webViewLink?: string; modifiedTime?: string };
    const sourceUrl = file.webViewLink || `https://drive.google.com/open?id=${encodeURIComponent(file.id)}`;
    const googleExport: Record<string, string> = { "application/vnd.google-apps.document": "text/plain", "application/vnd.google-apps.spreadsheet": "text/csv" };
    const url = googleExport[file.mimeType]
      ? `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerId)}/export?mimeType=${encodeURIComponent(googleExport[file.mimeType])}`
      : `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(providerId)}?alt=media`;
    const contentResponse = await fetch(url, { headers: { Authorization: `Bearer ${this.accessToken}` }, cache: "no-store" });
    if (!contentResponse.ok) throw new Error(`DRIVE_READ_FAILED:${contentResponse.status}`);
    const bytes = Buffer.from(await contentResponse.arrayBuffer());
    const extractedText = file.mimeType === "application/pdf" ? extractSimplePdfText(bytes) : bytes.toString("utf8");
    return { providerId: file.id, name: file.name, mimeType: file.mimeType, sourceUrl, providerMode: "live" as const, modifiedAt: file.modifiedTime, extractedText };
  }

  async health() { return { status: "healthy" as const, detail: "Google Drive OAuth connection is active." }; }
}
