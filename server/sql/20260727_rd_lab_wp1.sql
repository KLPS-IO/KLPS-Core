BEGIN;
CREATE SCHEMA IF NOT EXISTS rd_lab;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS rd_lab.password_credentials (
  user_id uuid PRIMARY KEY REFERENCES data_room.users(id) ON DELETE CASCADE,
  password_hash text NOT NULL,
  password_updated_at timestamptz NOT NULL DEFAULT now(),
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rd_lab.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email_hash text NOT NULL, ip_hash text,
  succeeded boolean NOT NULL, attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rd_login_attempt_lookup ON rd_lab.login_attempts(email_hash,ip_hash,attempted_at DESC);

CREATE OR REPLACE FUNCTION rd_lab.set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at=now(); RETURN NEW; END $$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS rd_lab.work_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), code text NOT NULL UNIQUE, title text NOT NULL,
  objective text NOT NULL, description text, status text NOT NULL CHECK(status IN
  ('Draft','Research','Supplier Discovery','Discovery Meetings','RFQ Preparation','RFQ Issued','Quotes Received','Evaluation','Supplier Selected','In Delivery','Validated','Paused','Closed')),
  sequence integer NOT NULL, owner_user_id uuid NOT NULL REFERENCES data_room.users(id),
  target_start_date date, target_end_date date, version integer NOT NULL DEFAULT 1,
  change_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES data_room.users(id), updated_by uuid REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  organisation_name text NOT NULL, category text NOT NULL CHECK(category IN
  ('Academic & Research Organisation','Commercial Smart Textile Developer','Conductive Textile & Fibre Supplier','Graphene Material Specialist','Printed Electronics Specialist','Textile Testing Laboratory','Prototype Integration Partner')),
  organisation_type text, country text, website text, summary text, relevant_capability text,
  commercial_services_status text, paid_feasibility_status text, sme_support_status text,
  existing_relationship text, priority_tier text, procurement_status text NOT NULL DEFAULT 'Researching' CHECK(procurement_status IN
  ('Researching','Longlisted','Shortlisted','Contacted','Meeting Booked','Discovery Complete','RFQ Planned','RFQ Sent','Quote Received','Declined','Not Suitable','Selected','Reserve')),
  source_reference text, research_notes text, version integer NOT NULL DEFAULT 1, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.supplier_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES rd_lab.suppliers(id) ON DELETE CASCADE,
  full_name text NOT NULL, role text, email text NOT NULL, phone text, linkedin_url text,
  preferred_contact_method text, notes text, version integer NOT NULL DEFAULT 1, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES rd_lab.suppliers(id) ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  interaction_type text NOT NULL, occurred_at timestamptz NOT NULL, attendees text, summary text NOT NULL,
  technical_learning text, commercial_learning text, actions text, follow_up_date date, status text,
  version integer NOT NULL DEFAULT 1, change_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.rfqs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  supplier_id uuid NOT NULL REFERENCES rd_lab.suppliers(id) ON DELETE RESTRICT, rfq_code text NOT NULL UNIQUE, title text NOT NULL,
  scope_summary text, sent_at timestamptz, response_due_at timestamptz, status text NOT NULL DEFAULT 'Draft' CHECK(status IN
  ('Draft','Ready','Sent','Acknowledged','Clarification','Response Received','Declined','Closed')),
  requested_quote_type text, requested_letter_of_support boolean NOT NULL DEFAULT false,
  requested_expression_of_interest boolean NOT NULL DEFAULT false, vat_required boolean NOT NULL DEFAULT true,
  min_likely_max_requested boolean NOT NULL DEFAULT true, assumptions text, confidentiality_notes text,
  version integer NOT NULL DEFAULT 1, change_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), supplier_id uuid NOT NULL REFERENCES rd_lab.suppliers(id) ON DELETE RESTRICT,
  work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT, rfq_id uuid REFERENCES rd_lab.rfqs(id) ON DELETE SET NULL,
  quote_reference text NOT NULL, quote_date date, valid_until date, currency text NOT NULL DEFAULT 'GBP',
  vat_included boolean, net_amount numeric, vat_amount numeric, gross_amount numeric, minimum_amount numeric, likely_amount numeric,
  maximum_amount numeric, one_off_development_cost numeric, materials_cost numeric, testing_cost numeric, tooling_or_nre numeric,
  estimated_unit_cost numeric, moq numeric, lead_time_text text, payment_schedule text, scope text, deliverables text,
  assumptions text, exclusions text, dependencies text, testing_included boolean, wash_testing_included boolean,
  stretch_testing_included boolean, electrical_characterisation_included boolean, garment_integration_included boolean,
  documentation_included boolean, foreground_ip_terms text, background_ip_restrictions text, data_ownership text,
  sample_ownership text, publication_rights text, confidentiality_terms text, recommendation text, decision_status text,
  evidence_confidence text, version integer NOT NULL DEFAULT 1, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.technical_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES rd_lab.suppliers(id) ON DELETE SET NULL, interaction_id uuid REFERENCES rd_lab.interactions(id) ON DELETE SET NULL,
  title text NOT NULL, finding text NOT NULL, source_type text, impact_on_mvp text, decision_required boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'Observation' CHECK(status IN ('Observation','To Validate','Accepted','Rejected','Superseded')),
  version integer NOT NULL DEFAULT 1, change_reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.action_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  supplier_id uuid REFERENCES rd_lab.suppliers(id) ON DELETE SET NULL, title text NOT NULL, description text, owner text NOT NULL,
  priority text NOT NULL CHECK(priority IN ('Critical','High','Medium','Low')), due_date date,
  status text NOT NULL DEFAULT 'To Do' CHECK(status IN ('To Do','In Progress','Waiting','Blocked','Complete','Cancelled')),
  completed_at timestamptz, version integer NOT NULL DEFAULT 1, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.friction_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  workflow_step text NOT NULL, existing_finance_os_support text, friction text NOT NULL, temporary_workaround text,
  consequence text, enhancement_needed text, urgency text, status text, version integer NOT NULL DEFAULT 1, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.finance_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), work_package_id uuid NOT NULL REFERENCES rd_lab.work_packages(id) ON DELETE RESTRICT,
  source_entity_type text NOT NULL, source_entity_id uuid NOT NULL, proposed_destination text NOT NULL,
  proposed_amount numeric, financial_treatment text, timing text, evidence_id uuid REFERENCES finance_os.evidence(id),
  mapping_status text NOT NULL DEFAULT 'Not Reviewed' CHECK(mapping_status IN ('Not Reviewed','Ready to Map','Mapped','Rejected','Superseded')),
  notes text, version integer NOT NULL DEFAULT 1, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id), updated_by uuid NOT NULL REFERENCES data_room.users(id)
);
CREATE TABLE IF NOT EXISTS rd_lab.record_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), entity_type text NOT NULL, entity_id uuid NOT NULL,
  version integer NOT NULL, snapshot jsonb NOT NULL, change_reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(entity_type,entity_id,version)
);

DO $$ DECLARE t text; BEGIN
FOREACH t IN ARRAY ARRAY['work_packages','suppliers','supplier_contacts','interactions','rfqs','quotations','technical_findings','action_items','friction_log','finance_mappings']
LOOP EXECUTE format('DROP TRIGGER IF EXISTS %I_set_updated_at ON rd_lab.%I',t,t);
EXECUTE format('CREATE TRIGGER %I_set_updated_at BEFORE UPDATE ON rd_lab.%I FOR EACH ROW EXECUTE FUNCTION rd_lab.set_updated_at()',t,t); END LOOP; END $$;
CREATE INDEX IF NOT EXISTS rd_suppliers_wp_status ON rd_lab.suppliers(work_package_id,procurement_status);
CREATE INDEX IF NOT EXISTS rd_actions_wp_status ON rd_lab.action_items(work_package_id,status,priority);
CREATE INDEX IF NOT EXISTS rd_rfqs_wp_status ON rd_lab.rfqs(work_package_id,status);

INSERT INTO rd_lab.work_packages(code,title,objective,description,status,sequence,owner_user_id,change_reason,created_by,updated_by)
SELECT 'WP1','Textile Sensing',
'Identify and cost at least one textile sensing approach capable of detecting repeatable abdominal changes relative to a personal baseline.',
'Evidence-led sensing textile feasibility for KLPS MVP V2. No diagnostic claims.',
'Supplier Discovery',1,id,'Initial approved WP1 work package seed.',id,id
FROM data_room.users WHERE role='founder_admin' ORDER BY created_at LIMIT 1
ON CONFLICT(code) DO NOTHING;

ALTER TABLE finance_os.evidence_links DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK(entity_type IN
('assumption','product','decision','risk','company','funding','kpi','report','scenario','hire','document','expense','rd_work_package','rd_supplier','rd_rfq','rd_quotation'));
COMMIT;
