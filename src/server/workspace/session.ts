import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { isConfiguredSecret, runtimeConfig } from "@/server/config";

export const DEMO_SESSION_COOKIE = "recovery_demo_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

export interface DemoSession {
  workspaceId: string;
  isNew: boolean;
  setCookie?: string;
}

function sign(value: string) {
  const secret = runtimeConfig().demoSessionSecret;
  if (process.env.NODE_ENV === "production" && (!isConfiguredSecret(process.env.DEMO_SESSION_SECRET) || secret === "local-fixture-demo-session-secret-change-me")) throw new Error("SESSION_SECRET_REQUIRED:Production demo sessions require DEMO_SESSION_SECRET.");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

function encode(workspaceId: string, expiresAt: number) {
  const payload = `${workspaceId}.${expiresAt}`;
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sign(payload)}`;
}

function decode(value: string | undefined) {
  if (!value) return null;
  const [encoded, receivedSignature] = value.split(".");
  if (!encoded || !receivedSignature) return null;
  let payload: string;
  try { payload = Buffer.from(encoded, "base64url").toString("utf8"); } catch { return null; }
  const [workspaceId, expiresAtValue] = payload.split(".");
  const expiresAt = Number(expiresAtValue);
  if (!workspaceId || !expiresAt || expiresAt < Math.floor(Date.now() / 1000)) return null;
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return null;
  const expected = Buffer.from(sign(payload), "utf8");
  const received = Buffer.from(receivedSignature, "utf8");
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  return { workspaceId, expiresAt };
}

function cookieHeader(workspaceId: string) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${DEMO_SESSION_COOKIE}=${encode(workspaceId, expiresAt)}; Path=/; Max-Age=${SESSION_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
}

export function getDemoSession(request: Request): DemoSession {
  const cookieHeaderValue = request.headers.get("cookie") || "";
  const value = cookieHeaderValue.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${DEMO_SESSION_COOKIE}=`))?.slice(DEMO_SESSION_COOKIE.length + 1);
  const decoded = decode(value);
  if (decoded) return { workspaceId: decoded.workspaceId, isNew: false };
  const workspaceId = randomUUID();
  return { workspaceId, isNew: true, setCookie: cookieHeader(workspaceId) };
}

export function attachDemoSession(response: Response, session: DemoSession) {
  if (session.setCookie) response.headers.set("Set-Cookie", session.setCookie);
  return response;
}

export function freshDemoSession() {
  const workspaceId = randomUUID();
  return { workspaceId, setCookie: cookieHeader(workspaceId) };
}
