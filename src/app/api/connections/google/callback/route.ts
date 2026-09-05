import { isConfiguredSecret, runtimeConfig } from "@/server/config";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = runtimeConfig();
  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return Response.json({ error: { code: "OAUTH_DENIED", message: `Google authorization was not completed: ${error}.` } }, { status: 400 });
  if (config.evidenceProvider === "fixture") return Response.json({ ok: true, mode: "fixture", message: "Demo simulation: evidence comes from the labelled fixture corpus; no Google OAuth is used." });
  if (config.evidenceProvider === "google" && isConfiguredSecret(config.googleAccessToken)) return Response.json({ ok: true, mode: "live", message: "Google evidence adapter is configured server-side; no token is returned to the browser." });
  if (config.evidenceProvider === "google") return Response.json({ error: { code: "EVIDENCE_GOOGLE_TOKEN_REQUIRED", message: "Google evidence is selected but no server-side access token is configured." } }, { status: 503 });
  return Response.json({ error: { code: "EVIDENCE_COMPOSIO_NOT_IMPLEMENTED", message: "The selected Composio evidence provider is a deferred boundary in this build; no Google OAuth fallback is used." } }, { status: 501 });
}
