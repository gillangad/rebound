# Rebound

Rebound is an evidence-led merchant workspace for payment recovery. The flagship demo is Northstar Office and Atelier Works: an invoice blocker is retrieved from simulated Email and Drive evidence, converted into one approval-gated response, delivered with a secure document link and payment route, and collected only after a verified payment event.

The server owns correlation, policy checks, case transitions, approval revalidation, payment reconciliation, idempotency, audit history and the verified ledger. The agent can investigate and propose; it cannot claim payment success or perform an external action by itself.

## Local setup

Prerequisites: Node.js 20+, npm, and Docker Compose when the durable PostgreSQL/worker path is needed.

```powershell
Copy-Item .env.example .env.local
npm install
npm run dev:web
```

The default `.env.example` selects `AGENT_PROVIDER=fixture`, `EVIDENCE_PROVIDER=fixture`, and `PAYMENT_PROVIDER=fixture`. In this mode the web app is usable without credentials or PostgreSQL and shows an explicitly labelled, deterministic demo. Its in-process store is for local rehearsal only.

For durable local work, run the web server and worker in separate terminals:

```powershell
# Uncomment DATABASE_URL in .env.local first.
npm run db:start
npm run db:migrate
npm run db:seed
npm run dev:web
npm run worker
```

`npm run worker` is a persistent pg-boss worker. It processes queued jobs, restores jobs left running during a restart, and routes each mutation to the tenant that owns the job. `npm run dev:all` starts the web server and the worker only when `DATABASE_URL` is present; without it, the console says that the durable worker is not running.

The hosted Try Demo path is anonymous but isolated. The first merchant API request receives a signed `HttpOnly; SameSite=Lax` `recovery_demo_session` cookie. Its workspace ID selects a PostgreSQL snapshot; another browser receives another workspace. `Try Demo · Fresh start` or `POST /api/demo/reset` replaces only that workspace with the canonical starting state and records a reset audit event.

## Independent provider capabilities

These settings are intentionally separate:

| Variable | Values | Credential boundary |
| --- | --- | --- |
| `AGENT_PROVIDER` | `fixture`, `fireworks`, `codex_app_server` | Fixture is deterministic; Fireworks needs `FIREWORKS_API_KEY`; Codex uses the native local JSON-RPC app-server over `stdio://` and does not receive app or browser secrets. |
| `EVIDENCE_PROVIDER` | `fixture`, `google`, `composio` | Fixture retrieves a separate simulated Email/Drive corpus. `google` uses the server-side Gmail/Drive adapters and needs `GOOGLE_ACCESS_TOKEN` (or an encrypted connected token). `composio` is a declared deferred boundary and fails closed. |
| `PAYMENT_PROVIDER` | `fixture`, `razorpay_test` | Fixture payment verification is simulated. Razorpay test needs an `rzp_test_` key, secret and webhook secret. |
| storage | automatic | `DATABASE_URL` selects durable PostgreSQL; without it only the local fixture store is available. |

`APP_MODE=fixture|live` remains only as a backwards-compatible shortcut for older local files. `APP_MODE=live` selects Fireworks, Google evidence and Razorpay test; every selected capability is still checked independently. Missing credentials result in `Not configured`/an explicit error and never a simulated success.

The Connections page and the capability strip show each selected provider as Fixture, Ready, Not configured or Deferred. `/api/health` is liveness; `/api/health/readiness` checks PostgreSQL when configured. Google evidence requires `GOOGLE_ACCESS_TOKEN` or an encrypted connector token; it is never silently replaced with fixtures.

When `AGENT_PROVIDER=codex_app_server`, the server launches `CODEX_APP_SERVER_COMMAND app-server --stdio`, performs `initialize`/`initialized`, starts an ephemeral read-only thread, starts one bounded turn, consumes streamed completion notifications, validates the final JSON output, and closes the process. The native Codex process owns its own authentication boundary; the recovery app does not read browser state or forward provider secrets.

## Product flow

1. Open `/` and select Atelier Works. The reset state has no Atelier message, document, proposal, outbound message, active link, payment or ledger entry.
2. Submit `Review these cases. Resolve what you can within our policies, and bring me anything that needs approval.` The API persists the instruction and batch immediately; the worker or local fixture worker advances it asynchronously.
3. Inspect the evidence path: retrieved fixture Email → customer/invoice/order-matched Drive document → one `document_response` proposal. The Lumen document is a provider-corpus distractor and is rejected with an audit event.
4. Edit, approve or reject. Approval rechecks case version, recipient, document ownership/permission, outstanding balance, contact window, attempt spacing, incident and changed-circumstance rules. The sent fixture message is labelled simulation and contains both the obligation-scoped document URL and payment route.
5. Use the customer link at `/pay/[publicToken]`. Fixture payment exercises the same reconciliation path as a webhook, including partial/overpayment handling, deduplication, one ledger post, case recovery and stopped jobs. It is never real money.

Repeated polling is read-only. An unchanged canonical evidence/input hash produces an auditable skipped investigation and zero agent-provider calls. Inference runs happen only for an explicit instruction, new evidence, a changed circumstance or an approved workflow.

## Evaluation

The deterministic synthetic cohort is separate from the polished demo. Regenerate its measured report with:

```powershell
npm run evaluate
```

The runner writes the checked-in `evaluation-report.json` and an immutable run under `evaluation-runs/`; with `DATABASE_URL` and migrated tables it also stores the run and per-case results in PostgreSQL with conflict-safe inserts. The History page shows denominators, unresolved cases and an API-confirmed integration-proof panel. Fixture decisions, messages and payments never increment provider-confirmed counters.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e
```

The tests cover controlled clocks, policy and state transitions, fixture Email/Drive retrieval and distractor rejection, evidence-backed Atelier proposals, secure document/payment delivery, approval and job idempotency, signed Razorpay event validation, partial/full/overpayment reconciliation, signal deduplication, incident revalidation, changed circumstances, evaluation reproducibility and isolated demo workspaces. The browser smoke test covers reset/initial state, asynchronous batch progress, evidence inspection, approval, customer payment, refresh-visible recovery and secondary surfaces.

## Deployment readiness

`vercel.json` contains the Next.js web build configuration for the Next.js application. `render.yaml` describes only the persistent Render worker; it does not define a Render web service, database, or credentials. Production commands are:

```powershell
npm ci
npm run build

# Render worker
npm ci
npm run db:migrate
npm run worker:prod
```

Migrations are checked in and idempotent. Set the same `DATABASE_URL`, provider selections and server-side secrets on the web and worker. Register `/api/webhooks/razorpay` with Razorpay test mode and preserve the raw request body for the HMAC check. The webhook router identifies a tenant from the provider payment/link ID; unmatched signed events are rejected for review.

In this checkout, the live Fireworks application path was verified with a bounded investigation over clearly fixture-labelled Email/Drive evidence. The Razorpay test adapter was verified by creating, fetching and cancelling a ₹1 test Payment Link and probing the downtime endpoint. Still unverified are a native Codex app-server turn, Google/Gmail retrieval and delivery, Razorpay Checkout/card authorization, a signed live Razorpay webhook through the app and its live ledger posting, and any live outbound email. Composio remains a declared unsupported boundary. No credentials are fabricated and no hosted resources are provisioned here.
