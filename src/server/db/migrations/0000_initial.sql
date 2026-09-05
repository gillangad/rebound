CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN CREATE TYPE app_mode AS ENUM ('fixture', 'live'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE customer_type AS ENUM ('individual', 'business'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE obligation_kind AS ENUM ('purchase', 'invoice'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE obligation_status AS ENUM ('open', 'partially_paid', 'paid', 'cancelled', 'review_required'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE case_state AS ENUM ('detected', 'investigating', 'proposed', 'awaiting_approval', 'contacted', 'recovered', 'paused', 'escalated', 'closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE workflow_type AS ENUM ('failed_purchase', 'invoice_resolution', 'shared_incident'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE blocker_category AS ENUM ('payment_failed', 'missing_document', 'dispute', 'promise_to_pay', 'partial_payment', 'inability_to_pay', 'no_response', 'incident'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE blocker_category ADD VALUE IF NOT EXISTS 'opted_out'; EXCEPTION WHEN undefined_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE incident_confirmation AS ENUM ('confirmed', 'inferred', 'simulated'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE incident_status AS ENUM ('active', 'resolved'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE actor_type AS ENUM ('system', 'agent', 'merchant', 'customer', 'connector'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, mode app_mode NOT NULL,
  timezone text NOT NULL, default_currency varchar(3) NOT NULL,
  agent_provider text NOT NULL DEFAULT 'fixture', evidence_provider text NOT NULL DEFAULT 'fixture', payment_provider text NOT NULL DEFAULT 'fixture', storage_provider text NOT NULL DEFAULT 'postgres',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id),
  type customer_type NOT NULL, display_name text NOT NULL, email text NOT NULL, company text,
  external_refs jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, email)
);
CREATE TABLE IF NOT EXISTS obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), customer_id uuid NOT NULL REFERENCES customers(id),
  kind obligation_kind NOT NULL, amount_due integer NOT NULL CHECK (amount_due >= 0), amount_paid integer NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  currency varchar(3) NOT NULL, order_ref text, cart_ref text, invoice_ref text, status obligation_status NOT NULL DEFAULT 'open', due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, order_ref), UNIQUE (merchant_id, invoice_ref)
);
CREATE TABLE IF NOT EXISTS recovery_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), customer_id uuid NOT NULL REFERENCES customers(id), obligation_id uuid NOT NULL REFERENCES obligations(id),
  workflow workflow_type NOT NULL, state case_state NOT NULL, priority varchar(12) NOT NULL, blocker blocker_category NOT NULL, confidence_bps integer NOT NULL,
  reason text NOT NULL, next_action text NOT NULL, pause_reason text, pause_until timestamptz, assigned_incident_id uuid, version integer NOT NULL DEFAULT 1,
  last_agent_input_hash text, last_agent_run_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), type text NOT NULL, source text NOT NULL, external_id text NOT NULL,
  normalized_payload jsonb NOT NULL, occurred_at timestamptz NOT NULL, correlation_status text NOT NULL, obligation_id uuid REFERENCES obligations(id), case_id uuid REFERENCES recovery_cases(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, source, external_id)
);
CREATE TABLE IF NOT EXISTS payment_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), obligation_id uuid NOT NULL REFERENCES obligations(id), razorpay_payment_id text NOT NULL,
  amount integer NOT NULL, method text NOT NULL, status text NOT NULL, error_code text, error_description text, error_source text, error_step text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, razorpay_payment_id)
);
CREATE TABLE IF NOT EXISTS payment_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), obligation_id uuid NOT NULL REFERENCES obligations(id), razorpay_link_id text NOT NULL,
  reference_id text NOT NULL, amount integer NOT NULL, amount_paid integer NOT NULL DEFAULT 0, status text NOT NULL, url text NOT NULL, public_token text NOT NULL,
  accept_partial boolean NOT NULL DEFAULT true, expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, razorpay_link_id), UNIQUE (public_token), UNIQUE (merchant_id, obligation_id)
);
CREATE TABLE IF NOT EXISTS payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), obligation_id uuid NOT NULL REFERENCES obligations(id), payment_link_id uuid REFERENCES payment_links(id),
  razorpay_payment_id text NOT NULL, amount integer NOT NULL, verified boolean NOT NULL DEFAULT false, captured_at timestamptz, provider text NOT NULL, webhook_event_id text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, razorpay_payment_id), UNIQUE (merchant_id, webhook_event_id)
);
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), obligation_id uuid NOT NULL REFERENCES obligations(id), invoice_number text NOT NULL,
  issue_date timestamptz NOT NULL, due_date timestamptz NOT NULL, document_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, invoice_number)
);
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), case_id uuid REFERENCES recovery_cases(id), obligation_id uuid REFERENCES obligations(id),
  direction text NOT NULL, channel text NOT NULL, provider_id text NOT NULL, thread_id text, subject text NOT NULL, body text NOT NULL, participants jsonb NOT NULL,
  sent_at timestamptz, received_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), customer_id uuid REFERENCES customers(id), obligation_id uuid REFERENCES obligations(id),
  provider_id text NOT NULL, name text NOT NULL, mime_type text NOT NULL, extracted_text text NOT NULL, source_url text NOT NULL, checksum text NOT NULL, permission text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), source text NOT NULL, method text NOT NULL, provider text NOT NULL, instrument text NOT NULL,
  severity varchar(12) NOT NULL, confirmation incident_confirmation NOT NULL, status incident_status NOT NULL, started_at timestamptz NOT NULL, resolved_at timestamptz, summary text NOT NULL, evidence jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS incident_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), incident_id uuid NOT NULL REFERENCES incidents(id), case_id uuid NOT NULL REFERENCES recovery_cases(id), reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (incident_id, case_id)
);
CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), case_id uuid NOT NULL REFERENCES recovery_cases(id), obligation_id uuid NOT NULL REFERENCES obligations(id),
  type text NOT NULL, intended_outcome text NOT NULL, recipient text NOT NULL, scope text NOT NULL, channel text NOT NULL, structured_payload jsonb NOT NULL, evidence_ids jsonb NOT NULL,
  uncertainty text NOT NULL, explanation text NOT NULL, policy_result jsonb NOT NULL, requires_approval boolean NOT NULL, status text NOT NULL, model_run_id uuid, action_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), proposal_id uuid NOT NULL REFERENCES proposals(id), requested_by text NOT NULL, decided_by text,
  decision text NOT NULL, edited_payload jsonb, rationale text, decided_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), version integer NOT NULL, review_first boolean NOT NULL, allowed_channels jsonb NOT NULL,
  contact_start_hour integer NOT NULL, contact_end_hour integer NOT NULL, timezone text NOT NULL, max_attempts integer NOT NULL, minimum_spacing_hours integer NOT NULL, discounts_allowed boolean NOT NULL,
  auto_send_classes jsonb NOT NULL, incident_suppression boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, version)
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), kind text NOT NULL, idempotency_key text NOT NULL, status text NOT NULL, case_id uuid REFERENCES recovery_cases(id), proposal_id uuid REFERENCES proposals(id),
  run_after timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), obligation_id uuid NOT NULL REFERENCES obligations(id), payment_id uuid NOT NULL REFERENCES payments(id), amount integer NOT NULL CHECK (amount >= 0), currency varchar(3) NOT NULL,
  idempotency_key text NOT NULL, verified_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (merchant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), actor actor_type NOT NULL, event_type text NOT NULL, entity_type text NOT NULL, entity_id text NOT NULL,
  summary text NOT NULL, before_summary jsonb, after_summary jsonb, source_ids jsonb NOT NULL, provider text, invocation_reason text, input_hash text, usage jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), case_id uuid NOT NULL REFERENCES recovery_cases(id), provider text NOT NULL, model text NOT NULL,
  status text NOT NULL, step_count integer NOT NULL, tool_call_summaries jsonb NOT NULL, error text, invocation_reason text, input_hash text, skipped boolean NOT NULL DEFAULT false, usage jsonb, started_at timestamptz NOT NULL, finished_at timestamptz
);
CREATE TABLE IF NOT EXISTS connector_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), type text NOT NULL, mode text NOT NULL, status text NOT NULL, scopes jsonb NOT NULL,
  encrypted_token_ref text, last_sync_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recovery_state (
  id integer PRIMARY KEY, workspace_id uuid, merchant_id uuid NOT NULL, payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_merchant_created_idx ON audit_events (merchant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS recovery_cases_merchant_state_idx ON recovery_cases (merchant_id, state);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs (merchant_id, status, run_after);

-- Evidence provenance and durable orchestration additions. These statements
-- are intentionally idempotent so an existing local database can be upgraded
-- with the same migration command used for a fresh database.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS from_address text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS to_addresses jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_mode text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS provider_url text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS provider_mode text;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS match_reason text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS batch_run_id uuid;
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS agent_provider text NOT NULL DEFAULT 'fixture';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS evidence_provider text NOT NULL DEFAULT 'fixture';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS payment_provider text NOT NULL DEFAULT 'fixture';
ALTER TABLE merchants ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'postgres';
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS last_agent_input_hash text;
ALTER TABLE recovery_cases ADD COLUMN IF NOT EXISTS last_agent_run_id uuid;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS invocation_reason text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS input_hash text;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS skipped boolean NOT NULL DEFAULT false;
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS usage jsonb;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS provider text;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS invocation_reason text;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS input_hash text;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS usage jsonb;
ALTER TABLE recovery_state ADD COLUMN IF NOT EXISTS workspace_id uuid;

UPDATE recovery_state SET workspace_id = merchant_id WHERE workspace_id IS NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recovery_state_pkey') THEN
    ALTER TABLE recovery_state DROP CONSTRAINT recovery_state_pkey;
  END IF;
END $$;
ALTER TABLE recovery_state ALTER COLUMN id DROP NOT NULL;
ALTER TABLE recovery_state ALTER COLUMN workspace_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS recovery_state_workspace_idx ON recovery_state (workspace_id);

CREATE TABLE IF NOT EXISTS webhook_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), event_id text NOT NULL,
  raw_body text NOT NULL, payload_hash text NOT NULL, event_type text, provider_payment_id text, provider_link_id text,
  status text NOT NULL, received_at timestamptz NOT NULL, applied_at timestamptz,
  UNIQUE (merchant_id, event_id)
);
CREATE INDEX IF NOT EXISTS webhook_receipts_provider_payment_idx ON webhook_receipts (merchant_id, provider_payment_id);

CREATE TABLE IF NOT EXISTS merchant_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), case_id uuid REFERENCES recovery_cases(id),
  instruction text NOT NULL, intent text NOT NULL, status text NOT NULL, pause_until timestamptz, batch_run_id uuid,
  created_at timestamptz NOT NULL, completed_at timestamptz, error text
);
CREATE TABLE IF NOT EXISTS batch_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), merchant_id uuid NOT NULL REFERENCES merchants(id), instruction_id uuid NOT NULL REFERENCES merchant_instructions(id),
  instruction text NOT NULL, status text NOT NULL, concurrency integer NOT NULL, case_ids jsonb NOT NULL, completed_case_ids jsonb NOT NULL,
  failed_case_ids jsonb NOT NULL, started_at timestamptz NOT NULL, finished_at timestamptz, error text
);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'merchant_instructions_batch_run_fk') THEN
    ALTER TABLE merchant_instructions ADD CONSTRAINT merchant_instructions_batch_run_fk FOREIGN KEY (batch_run_id) REFERENCES batch_runs(id) NOT VALID;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_batch_run_fk') THEN
    ALTER TABLE jobs ADD CONSTRAINT jobs_batch_run_fk FOREIGN KEY (batch_run_id) REFERENCES batch_runs(id) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id uuid PRIMARY KEY, dataset_version text NOT NULL, build_id text NOT NULL, mode app_mode NOT NULL, provider text NOT NULL,
  started_at timestamptz NOT NULL, finished_at timestamptz NOT NULL, metrics jsonb NOT NULL, integration_proof jsonb NOT NULL,
  baseline jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS evaluation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES evaluation_runs(id), case_id text NOT NULL,
  expected jsonb NOT NULL, actual jsonb NOT NULL, status text NOT NULL, reason text, starting_outstanding integer NOT NULL, remaining_value integer NOT NULL,
  UNIQUE (run_id, case_id)
);
