import type { TransactionSql } from "postgres";
import type { DemoWorld } from "@/shared/types";

type Db = TransactionSql;

const json = (value: unknown) => JSON.stringify(value);

/**
 * Keeps the normalized tables and the small recovery snapshot in agreement.
 * The snapshot is used to hydrate the domain aggregate in this demo-sized
 * implementation; these rows make the durable PostgreSQL model inspectable and
 * give future repository queries a lossless, tenant-scoped source of records.
 */
export async function replaceNormalizedWorld(db: Db, world: DemoWorld) {
  const merchantId = world.merchant.id;
  const customerRows = world.customers.map((item) => ({ id: item.id, type: item.type, display_name: item.displayName, email: item.email, company: item.company || null, external_refs: {} }));
  const obligationRows = world.obligations.map((item) => ({ id: item.id, customer_id: item.customerId, kind: item.kind, amount_due: item.amountDue, amount_paid: item.amountPaid, currency: item.currency, order_ref: item.orderRef || null, cart_ref: item.cartRef || null, invoice_ref: item.invoiceRef || null, status: item.status, due_at: item.dueAt || null }));
  const caseRows = world.cases.map((item) => ({ id: item.id, customer_id: item.customerId, obligation_id: item.obligationId, workflow: item.workflow, state: item.state, priority: item.priority, blocker: item.blocker, confidence: item.confidence, reason: item.reason, next_action: item.nextAction, pause_reason: item.pauseReason || null, pause_until: item.pauseUntil || null, incident_id: item.incidentId || null, last_agent_input_hash: item.lastAgentInputHash || null, last_agent_run_id: item.lastAgentRunId || null, version: item.version, created_at: item.createdAt, updated_at: item.updatedAt }));
  const signalRows = world.signals.map((item) => ({ id: item.id, type: item.type, source: item.source, external_id: item.externalId, payload: item.payload, occurred_at: item.occurredAt, correlation_status: item.correlationStatus, obligation_id: item.obligationId || null, case_id: item.caseId || null }));
  const paymentAttemptRows = world.paymentAttempts.map((item) => ({ id: item.id, obligation_id: item.obligationId, razorpay_payment_id: item.razorpayPaymentId, amount: item.amount, method: item.method, status: item.status, error_code: item.errorCode || null, error_description: item.errorDescription || null, error_source: item.errorSource || null, error_step: item.errorStep || null, created_at: item.createdAt }));
  const paymentLinkRows = world.paymentLinks.map((item) => ({ id: item.id, obligation_id: item.obligationId, razorpay_link_id: item.razorpayLinkId, reference_id: item.referenceId, amount: item.amount, amount_paid: item.amountPaid, status: item.status, url: item.url, public_token: item.publicToken, accept_partial: item.acceptPartial, expires_at: item.expiresAt || null, created_at: item.createdAt }));
  const paymentRows = world.payments.map((item) => ({ id: item.id, obligation_id: item.obligationId, payment_link_id: item.paymentLinkId || null, razorpay_payment_id: item.razorpayPaymentId, amount: item.amount, verified: item.verified, captured_at: item.capturedAt || null, provider: item.provider, webhook_event_id: item.webhookEventId || null, created_at: item.createdAt }));
  const invoiceRows = world.invoices.map((item) => ({ id: item.id, obligation_id: item.obligationId, invoice_number: item.invoiceNumber, issue_date: item.issueDate, due_date: item.dueDate, document_id: item.documentId || null }));
  const messageRows = world.messages.map((item) => ({ id: item.id, case_id: item.caseId || null, obligation_id: item.obligationId || null, direction: item.direction, channel: item.channel, provider_id: item.providerId, thread_id: item.threadId || null, subject: item.subject, body: item.body, participants: item.participants, from_address: item.from || null, to_addresses: item.to || null, provider_mode: item.providerMode || null, provider_url: item.providerUrl || null, sent_at: item.sentAt || null, received_at: item.receivedAt || null }));
  const documentRows = world.documents.map((item) => ({ id: item.id, customer_id: item.customerId || null, obligation_id: item.obligationId || null, provider_id: item.providerId, name: item.name, mime_type: item.mimeType, extracted_text: item.extractedText, source_url: item.sourceUrl, checksum: item.checksum, permission: item.permission, provider_mode: item.providerMode || null, match_reason: item.matchReason || null }));
  const incidentRows = world.incidents.map((item) => ({ id: item.id, source: item.source, method: item.method, provider: item.provider, instrument: item.instrument, severity: item.severity, confirmation: item.confirmation, status: item.status, started_at: item.startedAt, resolved_at: item.resolvedAt || null, summary: item.summary, evidence: item.evidence }));
  const incidentCases = world.cases.filter((item) => item.incidentId).map((item) => ({ id: `${item.id.slice(0, 8)}-0000-4000-8000-${item.id.slice(-12)}`, incident_id: item.incidentId, case_id: item.id, reason: item.reason }));
  const proposalRows = world.proposals.map((item) => ({ id: item.id, case_id: item.caseId, obligation_id: item.obligationId, type: item.type, intended_outcome: item.intendedOutcome, recipient: item.recipient, scope: item.scope, channel: item.channel, payload: item.payload, evidence_ids: item.evidenceIds, uncertainty: item.uncertainty, explanation: item.explanation, policy: item.policy, requires_approval: item.requiresApproval, status: item.status, model_run_id: item.modelRunId || null, action_version: item.actionVersion, created_at: item.createdAt }));
  const approvalRows = world.approvals.map((item) => ({ id: item.id, proposal_id: item.proposalId, requested_by: item.requestedBy, decided_by: item.decidedBy || null, decision: item.decision, edited_payload: item.editedPayload || null, rationale: item.rationale || null, decided_at: item.decidedAt || null, created_at: item.createdAt }));
  const policyRows = [{ id: world.policy.id, version: world.policy.version, review_first: world.policy.reviewFirst, allowed_channels: world.policy.allowedChannels, contact_start_hour: world.policy.contactStartHour, contact_end_hour: world.policy.contactEndHour, timezone: world.policy.timezone, max_attempts: world.policy.maxAttempts, minimum_spacing_hours: world.policy.minimumSpacingHours, discounts_allowed: world.policy.discountsAllowed, auto_send_classes: world.policy.autoSendClasses, incident_suppression: world.policy.incidentSuppression, updated_at: world.policy.updatedAt }];
  const jobRows = world.jobs.map((item) => ({ id: item.id, kind: item.kind, idempotency_key: item.idempotencyKey, status: item.status, case_id: item.caseId || null, proposal_id: item.proposalId || null, batch_run_id: item.batchRunId || null, run_after: item.runAfter || null, attempts: item.attempts, last_error: item.lastError || null }));
  const ledgerRows = world.ledger.map((item) => ({ id: item.id, obligation_id: item.obligationId, payment_id: item.paymentId, amount: item.amount, currency: item.currency, idempotency_key: item.idempotencyKey, verified_at: item.verifiedAt }));
  const auditRows = world.audit.map((item) => ({ id: item.id, actor: item.actor, event_type: item.eventType, entity_type: item.entityType, entity_id: item.entityId, summary: item.summary, before: item.before || null, after: item.after || null, source_ids: item.sourceIds, provider: item.provider || null, invocation_reason: item.invocationReason || null, input_hash: item.inputHash || null, usage: item.usage || null, created_at: item.createdAt }));
  const agentRunRows = world.agentRuns.map((item) => ({ id: item.id, case_id: item.caseId, provider: item.provider, model: item.model, status: item.status, step_count: item.stepCount, tool_call_summaries: item.toolCallSummaries, error: item.error || null, invocation_reason: item.invocationReason || null, input_hash: item.inputHash || null, skipped: item.skipped || false, usage: item.usage || null, started_at: item.startedAt, finished_at: item.finishedAt || null }));
  const connectorRows = world.connectors.map((item) => ({ id: item.id, type: item.type, mode: item.mode, status: item.status, scopes: item.scopes, encrypted_token_ref: item.encryptedTokenRef || null, last_sync_at: item.lastSyncAt || null }));
  const webhookRows = world.webhookReceipts.map((item) => ({ id: item.id, event_id: item.eventId, raw_body: item.rawBody, payload_hash: item.payloadHash, event_type: item.eventType || null, provider_payment_id: item.providerPaymentId || null, provider_link_id: item.providerLinkId || null, status: item.status, received_at: item.receivedAt, applied_at: item.appliedAt || null }));
  const instructionRows = world.instructions.map((item) => ({ id: item.id, case_id: item.caseId || null, instruction: item.instruction, intent: item.intent, status: item.status, pause_until: item.pauseUntil || null, batch_run_id: null, created_at: item.createdAt, completed_at: item.completedAt || null, error: item.error || null }));
  const batchRows = world.batchRuns.map((item) => ({ id: item.id, instruction_id: item.instructionId, instruction: item.instruction, status: item.status, concurrency: item.concurrency, case_ids: item.caseIds, completed_case_ids: item.completedCaseIds, failed_case_ids: item.failedCaseIds, started_at: item.startedAt, finished_at: item.finishedAt || null, error: item.error || null }));

  // Delete children first so this remains safe with the foreign keys in the
  // checked-in migration. This operation is scoped to the demo merchant.
  await db`delete from ledger_entries where merchant_id = ${merchantId}`;
  await db`delete from webhook_receipts where merchant_id = ${merchantId}`;
  await db`delete from payments where merchant_id = ${merchantId}`;
  await db`delete from payment_links where merchant_id = ${merchantId}`;
  await db`delete from payment_attempts where merchant_id = ${merchantId}`;
  await db`delete from approvals where merchant_id = ${merchantId}`;
  await db`delete from jobs where merchant_id = ${merchantId}`;
  await db`delete from merchant_instructions where merchant_id = ${merchantId}`;
  await db`delete from batch_runs where merchant_id = ${merchantId}`;
  await db`delete from proposals where merchant_id = ${merchantId}`;
  await db`delete from agent_runs where merchant_id = ${merchantId}`;
  await db`delete from incident_cases where merchant_id = ${merchantId}`;
  await db`delete from signals where merchant_id = ${merchantId}`;
  await db`delete from messages where merchant_id = ${merchantId}`;
  await db`delete from invoices where merchant_id = ${merchantId}`;
  await db`delete from documents where merchant_id = ${merchantId}`;
  await db`delete from recovery_cases where merchant_id = ${merchantId}`;
  await db`delete from incidents where merchant_id = ${merchantId}`;
  await db`delete from obligations where merchant_id = ${merchantId}`;
  await db`delete from customers where merchant_id = ${merchantId}`;
  await db`delete from policies where merchant_id = ${merchantId}`;
  await db`delete from audit_events where merchant_id = ${merchantId}`;
  await db`delete from connector_accounts where merchant_id = ${merchantId}`;

  await db`
    insert into merchants (id, name, mode, timezone, default_currency, agent_provider, evidence_provider, payment_provider, storage_provider)
    values (${merchantId}, ${world.merchant.name}, ${world.merchant.mode}, ${world.merchant.timezone}, ${world.merchant.defaultCurrency}, ${world.merchant.agentProvider || "fixture"}, ${world.merchant.evidenceProvider || "fixture"}, ${world.merchant.paymentProvider || "fixture"}, ${world.merchant.storageProvider || "postgres"})
    on conflict (id) do update set name = excluded.name, mode = excluded.mode, timezone = excluded.timezone, default_currency = excluded.default_currency, agent_provider = excluded.agent_provider, evidence_provider = excluded.evidence_provider, payment_provider = excluded.payment_provider, storage_provider = excluded.storage_provider, updated_at = now()
  `;
  await db`
    insert into customers (id, merchant_id, type, display_name, email, company, external_refs)
    select x.id, ${merchantId}, x.type::customer_type, x.display_name, x.email, x.company, coalesce(x.external_refs, '{}'::jsonb)
    from jsonb_to_recordset(${json(customerRows)}::jsonb)
      as x(id uuid, type text, display_name text, email text, company text, external_refs jsonb)
  `;
  await db`
    insert into obligations (id, merchant_id, customer_id, kind, amount_due, amount_paid, currency, order_ref, cart_ref, invoice_ref, status, due_at)
    select x.id, ${merchantId}, x.customer_id, x.kind::obligation_kind, x.amount_due, x.amount_paid, x.currency, x.order_ref, x.cart_ref, x.invoice_ref, x.status::obligation_status, x.due_at::timestamptz
    from jsonb_to_recordset(${json(obligationRows)}::jsonb)
      as x(id uuid, customer_id uuid, kind text, amount_due integer, amount_paid integer, currency text, order_ref text, cart_ref text, invoice_ref text, status text, due_at text)
  `;
  await db`
    insert into recovery_cases (id, merchant_id, customer_id, obligation_id, workflow, state, priority, blocker, confidence_bps, reason, next_action, pause_reason, pause_until, assigned_incident_id, last_agent_input_hash, last_agent_run_id, version, created_at, updated_at)
    select x.id, ${merchantId}, x.customer_id, x.obligation_id, x.workflow::workflow_type, x.state::case_state, x.priority, x.blocker::blocker_category, round(x.confidence * 10000)::integer, x.reason, x.next_action, x.pause_reason, x.pause_until::timestamptz, x.incident_id, x.last_agent_input_hash, x.last_agent_run_id, x.version, x.created_at::timestamptz, x.updated_at::timestamptz
    from jsonb_to_recordset(${json(caseRows)}::jsonb)
      as x(id uuid, customer_id uuid, obligation_id uuid, workflow text, state text, priority text, blocker text, confidence numeric, reason text, next_action text, pause_reason text, pause_until text, incident_id uuid, last_agent_input_hash text, last_agent_run_id uuid, version integer, created_at text, updated_at text)
  `;
  await db`
    insert into signals (id, merchant_id, type, source, external_id, normalized_payload, occurred_at, correlation_status, obligation_id, case_id, created_at, updated_at)
    select x.id, ${merchantId}, x.type, x.source, x.external_id, x.payload, x.occurred_at::timestamptz, x.correlation_status, x.obligation_id, x.case_id, x.occurred_at::timestamptz, x.occurred_at::timestamptz
    from jsonb_to_recordset(${json(signalRows)}::jsonb)
      as x(id uuid, type text, source text, external_id text, payload jsonb, occurred_at text, correlation_status text, obligation_id uuid, case_id uuid)
  `;
  await db`
    insert into payment_attempts (id, merchant_id, obligation_id, razorpay_payment_id, amount, method, status, error_code, error_description, error_source, error_step, created_at, updated_at)
    select x.id, ${merchantId}, x.obligation_id, x.razorpay_payment_id, x.amount, x.method, x.status, x.error_code, x.error_description, x.error_source, x.error_step, x.created_at::timestamptz, x.created_at::timestamptz
    from jsonb_to_recordset(${json(paymentAttemptRows)}::jsonb)
      as x(id uuid, obligation_id uuid, razorpay_payment_id text, amount integer, method text, status text, error_code text, error_description text, error_source text, error_step text, created_at text)
  `;
  await db`
    insert into payment_links (id, merchant_id, obligation_id, razorpay_link_id, reference_id, amount, amount_paid, status, url, public_token, accept_partial, expires_at, created_at, updated_at)
    select x.id, ${merchantId}, x.obligation_id, x.razorpay_link_id, x.reference_id, x.amount, x.amount_paid, x.status, x.url, x.public_token, x.accept_partial, x.expires_at::timestamptz, x.created_at::timestamptz, x.created_at::timestamptz
    from jsonb_to_recordset(${json(paymentLinkRows)}::jsonb)
      as x(id uuid, obligation_id uuid, razorpay_link_id text, reference_id text, amount integer, amount_paid integer, status text, url text, public_token text, accept_partial boolean, expires_at text, created_at text)
  `;
  await db`
    insert into payments (id, merchant_id, obligation_id, payment_link_id, razorpay_payment_id, amount, verified, captured_at, provider, webhook_event_id, created_at, updated_at)
    select x.id, ${merchantId}, x.obligation_id, x.payment_link_id, x.razorpay_payment_id, x.amount, x.verified, x.captured_at::timestamptz, x.provider, x.webhook_event_id, x.created_at::timestamptz, x.created_at::timestamptz
    from jsonb_to_recordset(${json(paymentRows)}::jsonb)
      as x(id uuid, obligation_id uuid, payment_link_id uuid, razorpay_payment_id text, amount integer, verified boolean, captured_at text, provider text, webhook_event_id text, created_at text)
  `;
  await db`
    insert into invoices (id, merchant_id, obligation_id, invoice_number, issue_date, due_date, document_id)
    select x.id, ${merchantId}, x.obligation_id, x.invoice_number, x.issue_date::timestamptz, x.due_date::timestamptz, x.document_id
    from jsonb_to_recordset(${json(invoiceRows)}::jsonb)
      as x(id uuid, obligation_id uuid, invoice_number text, issue_date text, due_date text, document_id uuid)
  `;
  await db`
    insert into messages (id, merchant_id, case_id, obligation_id, direction, channel, provider_id, thread_id, subject, body, participants, from_address, to_addresses, provider_mode, provider_url, sent_at, received_at, created_at, updated_at)
    select x.id, ${merchantId}, x.case_id, x.obligation_id, x.direction, x.channel, x.provider_id, x.thread_id, x.subject, x.body, x.participants, x.from_address, x.to_addresses, x.provider_mode, x.provider_url, x.sent_at::timestamptz, x.received_at::timestamptz, coalesce(x.received_at::timestamptz, x.sent_at::timestamptz, now()), coalesce(x.received_at::timestamptz, x.sent_at::timestamptz, now())
    from jsonb_to_recordset(${json(messageRows)}::jsonb)
      as x(id uuid, case_id uuid, obligation_id uuid, direction text, channel text, provider_id text, thread_id text, subject text, body text, participants jsonb, from_address text, to_addresses jsonb, provider_mode text, provider_url text, sent_at text, received_at text)
  `;
  await db`
    insert into documents (id, merchant_id, customer_id, obligation_id, provider_id, name, mime_type, extracted_text, source_url, checksum, permission, provider_mode, match_reason)
    select x.id, ${merchantId}, x.customer_id, x.obligation_id, x.provider_id, x.name, x.mime_type, x.extracted_text, x.source_url, x.checksum, x.permission, x.provider_mode, x.match_reason
    from jsonb_to_recordset(${json(documentRows)}::jsonb)
      as x(id uuid, customer_id uuid, obligation_id uuid, provider_id text, name text, mime_type text, extracted_text text, source_url text, checksum text, permission text, provider_mode text, match_reason text)
  `;
  await db`
    insert into incidents (id, merchant_id, source, method, provider, instrument, severity, confirmation, status, started_at, resolved_at, summary, evidence)
    select x.id, ${merchantId}, x.source, x.method, x.provider, x.instrument, x.severity, x.confirmation::incident_confirmation, x.status::incident_status, x.started_at::timestamptz, x.resolved_at::timestamptz, x.summary, x.evidence
    from jsonb_to_recordset(${json(incidentRows)}::jsonb)
      as x(id uuid, source text, method text, provider text, instrument text, severity text, confirmation text, status text, started_at text, resolved_at text, summary text, evidence jsonb)
  `;
  await db`
    insert into incident_cases (id, merchant_id, incident_id, case_id, reason)
    select x.id, ${merchantId}, x.incident_id, x.case_id, x.reason
    from jsonb_to_recordset(${json(incidentCases)}::jsonb)
      as x(id uuid, incident_id uuid, case_id uuid, reason text)
  `;
  await db`
    insert into proposals (id, merchant_id, case_id, obligation_id, type, intended_outcome, recipient, scope, channel, structured_payload, evidence_ids, uncertainty, explanation, policy_result, requires_approval, status, model_run_id, action_version, created_at, updated_at)
    select x.id, ${merchantId}, x.case_id, x.obligation_id, x.type, x.intended_outcome, x.recipient, x.scope, x.channel, x.payload, x.evidence_ids, x.uncertainty, x.explanation, x.policy, x.requires_approval, x.status, x.model_run_id, x.action_version, x.created_at::timestamptz, x.created_at::timestamptz
    from jsonb_to_recordset(${json(proposalRows)}::jsonb)
      as x(id uuid, case_id uuid, obligation_id uuid, type text, intended_outcome text, recipient text, scope text, channel text, payload jsonb, evidence_ids jsonb, uncertainty text, explanation text, policy jsonb, requires_approval boolean, status text, model_run_id uuid, action_version integer, created_at text)
  `;
  await db`
    insert into approvals (id, merchant_id, proposal_id, requested_by, decided_by, decision, edited_payload, rationale, decided_at, created_at, updated_at)
    select x.id, ${merchantId}, x.proposal_id, x.requested_by, x.decided_by, x.decision, x.edited_payload, x.rationale, x.decided_at::timestamptz, x.created_at::timestamptz, x.created_at::timestamptz
    from jsonb_to_recordset(${json(approvalRows)}::jsonb)
      as x(id uuid, proposal_id uuid, requested_by text, decided_by text, decision text, edited_payload jsonb, rationale text, decided_at text, created_at text)
  `;
  await db`
    insert into policies (id, merchant_id, version, review_first, allowed_channels, contact_start_hour, contact_end_hour, timezone, max_attempts, minimum_spacing_hours, discounts_allowed, auto_send_classes, incident_suppression, created_at, updated_at)
    select x.id, ${merchantId}, x.version, x.review_first, x.allowed_channels, x.contact_start_hour, x.contact_end_hour, x.timezone, x.max_attempts, x.minimum_spacing_hours, x.discounts_allowed, x.auto_send_classes, x.incident_suppression, x.updated_at::timestamptz, x.updated_at::timestamptz
    from jsonb_to_recordset(${json(policyRows)}::jsonb)
      as x(id uuid, version integer, review_first boolean, allowed_channels jsonb, contact_start_hour integer, contact_end_hour integer, timezone text, max_attempts integer, minimum_spacing_hours integer, discounts_allowed boolean, auto_send_classes jsonb, incident_suppression boolean, updated_at text)
  `;
  await db`
    insert into merchant_instructions (id, merchant_id, case_id, instruction, intent, status, pause_until, batch_run_id, created_at, completed_at, error)
    select x.id, ${merchantId}, x.case_id, x.instruction, x.intent, x.status, x.pause_until::timestamptz, null, x.created_at::timestamptz, x.completed_at::timestamptz, x.error
    from jsonb_to_recordset(${json(instructionRows)}::jsonb)
      as x(id uuid, case_id uuid, instruction text, intent text, status text, pause_until text, batch_run_id uuid, created_at text, completed_at text, error text)
  `;
  await db`
    insert into batch_runs (id, merchant_id, instruction_id, instruction, status, concurrency, case_ids, completed_case_ids, failed_case_ids, started_at, finished_at, error)
    select x.id, ${merchantId}, x.instruction_id, x.instruction, x.status, x.concurrency, x.case_ids, x.completed_case_ids, x.failed_case_ids, x.started_at::timestamptz, x.finished_at::timestamptz, x.error
    from jsonb_to_recordset(${json(batchRows)}::jsonb)
      as x(id uuid, instruction_id uuid, instruction text, status text, concurrency integer, case_ids jsonb, completed_case_ids jsonb, failed_case_ids jsonb, started_at text, finished_at text, error text)
  `;
  await db`
    update merchant_instructions as instructions
    set batch_run_id = batches.id
    from batch_runs as batches
    where instructions.merchant_id = ${merchantId} and instructions.id = batches.instruction_id
  `;
  await db`
    insert into webhook_receipts (id, merchant_id, event_id, raw_body, payload_hash, event_type, provider_payment_id, provider_link_id, status, received_at, applied_at)
    select x.id, ${merchantId}, x.event_id, x.raw_body, x.payload_hash, x.event_type, x.provider_payment_id, x.provider_link_id, x.status, x.received_at::timestamptz, x.applied_at::timestamptz
    from jsonb_to_recordset(${json(webhookRows)}::jsonb)
      as x(id uuid, event_id text, raw_body text, payload_hash text, event_type text, provider_payment_id text, provider_link_id text, status text, received_at text, applied_at text)
  `;
  await db`
    insert into jobs (id, merchant_id, kind, idempotency_key, status, case_id, proposal_id, batch_run_id, run_after, attempts, last_error)
    select x.id, ${merchantId}, x.kind, x.idempotency_key, x.status, x.case_id, x.proposal_id, x.batch_run_id, x.run_after::timestamptz, x.attempts, x.last_error
    from jsonb_to_recordset(${json(jobRows)}::jsonb)
      as x(id uuid, kind text, idempotency_key text, status text, case_id uuid, proposal_id uuid, batch_run_id uuid, run_after text, attempts integer, last_error text)
  `;
  await db`
    insert into ledger_entries (id, merchant_id, obligation_id, payment_id, amount, currency, idempotency_key, verified_at)
    select x.id, ${merchantId}, x.obligation_id, x.payment_id, x.amount, x.currency, x.idempotency_key, x.verified_at::timestamptz
    from jsonb_to_recordset(${json(ledgerRows)}::jsonb)
      as x(id uuid, obligation_id uuid, payment_id uuid, amount integer, currency text, idempotency_key text, verified_at text)
  `;
  await db`
    insert into audit_events (id, merchant_id, actor, event_type, entity_type, entity_id, summary, before_summary, after_summary, source_ids, provider, invocation_reason, input_hash, usage, created_at)
    select x.id, ${merchantId}, x.actor::actor_type, x.event_type, x.entity_type, x.entity_id, x.summary, x.before, x.after, x.source_ids, x.provider, x.invocation_reason, x.input_hash, x.usage, x.created_at::timestamptz
    from jsonb_to_recordset(${json(auditRows)}::jsonb)
      as x(id uuid, actor text, event_type text, entity_type text, entity_id text, summary text, before jsonb, after jsonb, source_ids jsonb, provider text, invocation_reason text, input_hash text, usage jsonb, created_at text)
  `;
  await db`
    insert into agent_runs (id, merchant_id, case_id, provider, model, status, step_count, tool_call_summaries, error, invocation_reason, input_hash, skipped, usage, started_at, finished_at)
    select x.id, ${merchantId}, x.case_id, x.provider, x.model, x.status, x.step_count, x.tool_call_summaries, x.error, x.invocation_reason, x.input_hash, x.skipped, x.usage, x.started_at::timestamptz, x.finished_at::timestamptz
    from jsonb_to_recordset(${json(agentRunRows)}::jsonb)
      as x(id uuid, case_id uuid, provider text, model text, status text, step_count integer, tool_call_summaries jsonb, error text, invocation_reason text, input_hash text, skipped boolean, usage jsonb, started_at text, finished_at text)
  `;
  await db`
    insert into connector_accounts (id, merchant_id, type, mode, status, scopes, encrypted_token_ref, last_sync_at)
    select x.id, ${merchantId}, x.type, x.mode, x.status, x.scopes, x.encrypted_token_ref, x.last_sync_at::timestamptz
    from jsonb_to_recordset(${json(connectorRows)}::jsonb)
      as x(id uuid, type text, mode text, status text, scopes jsonb, encrypted_token_ref text, last_sync_at text)
  `;
}
