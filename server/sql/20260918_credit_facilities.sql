BEGIN;
ALTER TABLE finance_os.bank_accounts ADD COLUMN classification text NOT NULL DEFAULT 'unknown' CHECK(classification IN ('cash_current','revolving_credit','unknown'));
ALTER TABLE finance_os.bank_accounts ADD COLUMN classification_reviewed_at timestamptz;
ALTER TABLE finance_os.bank_accounts ADD COLUMN classification_reviewed_by uuid REFERENCES data_room.users(id);
ALTER TABLE finance_os.bank_accounts ADD COLUMN stable_import_key text UNIQUE;
CREATE TABLE finance_os.credit_facilities (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), company_id uuid REFERENCES finance_os.company(id),
 bank_account_id uuid NOT NULL UNIQUE REFERENCES finance_os.bank_accounts(id),
 provider text NOT NULL, legal_lender text NOT NULL, facility_type text NOT NULL CHECK(facility_type='revolving_business_credit'),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), agreement_date date,
 provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES data_room.users(id),
 version int NOT NULL DEFAULT 1, change_reason text NOT NULL
);
CREATE TABLE finance_os.credit_term_versions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), facility_id uuid NOT NULL REFERENCES finance_os.credit_facilities(id),
 version int NOT NULL CHECK(version>0), effective_from date, effective_to date,
 terms jsonb NOT NULL CHECK(jsonb_typeof(terms)='object'), provenance jsonb NOT NULL CHECK(jsonb_typeof(provenance)='object'),
 review_status text NOT NULL DEFAULT 'extracted' CHECK(review_status IN ('extracted','reviewed','conflicted')),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES data_room.users(id),
 change_reason text NOT NULL, UNIQUE(facility_id,version), CHECK(effective_to IS NULL OR effective_to>=effective_from)
);
CREATE TABLE finance_os.credit_statements (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), facility_id uuid NOT NULL REFERENCES finance_os.credit_facilities(id),
 provider_reference text NOT NULL, version int NOT NULL DEFAULT 1,
 period_start date, period_end date, statement_date date, due_date date, collection_date date,
 closing_balance numeric(20,8), minimum_due numeric(20,8), overdue_amount numeric(20,8), interest numeric(20,8), fees numeric(20,8),
 currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'), evidence_id uuid NOT NULL REFERENCES finance_os.evidence(id), evidence_file_version int NOT NULL,
 provenance jsonb NOT NULL, review_status text NOT NULL DEFAULT 'extracted' CHECK(review_status IN ('extracted','reviewed','conflicted')),
 created_at timestamptz NOT NULL DEFAULT now(), created_by uuid NOT NULL REFERENCES data_room.users(id), change_reason text NOT NULL,
 UNIQUE(facility_id,provider_reference,version), CHECK(minimum_due IS NULL OR minimum_due>=0), CHECK(period_end IS NULL OR period_end>=period_start)
);
CREATE TABLE finance_os.bank_balance_observations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bank_account_id uuid NOT NULL REFERENCES finance_os.bank_accounts(id),
 metric text NOT NULL CHECK(metric IN ('cash_booked','cash_available','credit_limit','available_credit','outstanding_debt','pending_holds')),
 value numeric(20,8) NOT NULL, currency text NOT NULL CHECK(currency ~ '^[A-Z]{3}$'),
 as_of timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 evidence_id uuid NOT NULL REFERENCES finance_os.evidence(id), evidence_file_version int NOT NULL,
 provenance jsonb NOT NULL, review_status text NOT NULL DEFAULT 'extracted' CHECK(review_status IN ('extracted','reviewed','conflicted')),
 created_by uuid NOT NULL REFERENCES data_room.users(id), change_reason text NOT NULL
);
CREATE INDEX bank_balance_latest ON finance_os.bank_balance_observations(bank_account_id,metric,as_of DESC);
ALTER TABLE finance_os.bank_sync_runs ADD COLUMN evidence_id uuid REFERENCES finance_os.evidence(id);
ALTER TABLE finance_os.bank_sync_runs ADD COLUMN adapter_version text;
ALTER TABLE finance_os.bank_sync_runs ADD COLUMN coverage_complete boolean NOT NULL DEFAULT false;
ALTER TABLE finance_os.bank_transactions ADD COLUMN event_kind text NOT NULL DEFAULT 'unknown' CHECK(event_kind IN ('purchase','repayment','refund','interest','fee','cash_withdrawal','unknown'));
ALTER TABLE finance_os.bank_transactions ADD COLUMN source_evidence_id uuid REFERENCES finance_os.evidence(id);
ALTER TABLE finance_os.bank_transactions ADD COLUMN source_row int;
ALTER TABLE finance_os.bank_transactions ADD COLUMN conflict_payload jsonb;
ALTER TABLE finance_os.bank_transactions ADD COLUMN match_kind text CHECK(match_kind IN ('expense','transfer'));
ALTER TABLE finance_os.bank_transactions ADD COLUMN counterpart_transaction_id uuid UNIQUE REFERENCES finance_os.bank_transactions(id);
ALTER TABLE finance_os.bank_transactions ADD COLUMN reviewed_by uuid REFERENCES data_room.users(id);
ALTER TABLE finance_os.bank_transactions ADD COLUMN reviewed_at timestamptz;
-- Replace only the original expense/matched invariant, preserving all other checks.
DO $$ DECLARE c record; BEGIN
 FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='finance_os.bank_transactions'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%expense_id%' LOOP
 EXECUTE format('ALTER TABLE finance_os.bank_transactions DROP CONSTRAINT %I',c.conname);
 END LOOP;
END $$;
UPDATE finance_os.bank_transactions SET match_kind='expense' WHERE expense_id IS NOT NULL;
ALTER TABLE finance_os.bank_transactions ADD CONSTRAINT bank_match_target CHECK (
 (reconciliation_status IN ('matched','conflict') AND ((match_kind='expense' AND expense_id IS NOT NULL AND counterpart_transaction_id IS NULL) OR (match_kind='transfer' AND counterpart_transaction_id IS NOT NULL AND expense_id IS NULL)))
 OR (reconciliation_status<>'matched' AND match_kind IS NULL AND expense_id IS NULL AND counterpart_transaction_id IS NULL)
);
ALTER TABLE finance_os.bank_transactions ADD CHECK(counterpart_transaction_id IS NULL OR counterpart_transaction_id<>id);
ALTER TABLE finance_os.bank_connections ADD CONSTRAINT manual_source_no_tokens CHECK(provider NOT LIKE '%\_csv' ESCAPE '\' AND provider<>'manual' OR (encrypted_access_token IS NULL AND encrypted_refresh_token IS NULL AND token_expires_at IS NULL AND cardinality(granted_scopes)=0));
ALTER TABLE finance_os.evidence_links ADD COLUMN field_provenance jsonb;
ALTER TABLE finance_os.evidence_links DROP CONSTRAINT evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK(entity_type IN (
 'assumption','product','decision','risk','company','funding','kpi','report','scenario','hire','document','expense','expense_adjustment','vat_filing',
 'rd_work_package','rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation',
 'credit_facility','credit_term_version','credit_statement','bank_balance_observation','bank_account','bank_sync_run','bank_transaction'));
CREATE FUNCTION finance_os.validate_credit_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item record; ev record; fields jsonb;
BEGIN
 fields:=CASE WHEN TG_TABLE_NAME='credit_term_versions' THEN to_jsonb(NEW)->'terms' ELSE jsonb_build_object('provider',to_jsonb(NEW)->'provider','legal_lender',to_jsonb(NEW)->'legal_lender','facility_type',to_jsonb(NEW)->'facility_type','currency',to_jsonb(NEW)->'currency','agreement_date',to_jsonb(NEW)->'agreement_date') END;
 FOR item IN SELECT key,value FROM jsonb_each(fields) WHERE value<>'null'::jsonb LOOP
  IF NOT NEW.provenance ? item.key THEN RAISE EXCEPTION 'Missing contractual provenance: %',item.key; END IF;
  SELECT id,file_version INTO ev FROM finance_os.evidence WHERE id=(NEW.provenance->item.key->>'evidence_id')::uuid;
  IF ev.id IS NULL OR ev.file_version IS DISTINCT FROM (NEW.provenance->item.key->>'file_version')::int OR COALESCE((NEW.provenance->item.key->>'page')::int,0)<1 OR COALESCE(NEW.provenance->item.key->>'locator','')='' THEN RAISE EXCEPTION 'Invalid contractual evidence locator: %',item.key; END IF;
 END LOOP; RETURN NEW;
END $$;
CREATE TRIGGER credit_facility_provenance BEFORE INSERT ON finance_os.credit_facilities FOR EACH ROW EXECUTE FUNCTION finance_os.validate_credit_provenance();
CREATE TRIGGER credit_terms_provenance BEFORE INSERT ON finance_os.credit_term_versions FOR EACH ROW EXECUTE FUNCTION finance_os.validate_credit_provenance();
CREATE FUNCTION finance_os.credit_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Credit history is append-only; create a superseding version'; END $$;
CREATE TRIGGER credit_terms_immutable BEFORE UPDATE OR DELETE ON finance_os.credit_term_versions FOR EACH ROW EXECUTE FUNCTION finance_os.credit_history_immutable();
CREATE TRIGGER credit_statements_immutable BEFORE UPDATE OR DELETE ON finance_os.credit_statements FOR EACH ROW EXECUTE FUNCTION finance_os.credit_history_immutable();
CREATE TRIGGER balance_observations_immutable BEFORE UPDATE OR DELETE ON finance_os.bank_balance_observations FOR EACH ROW EXECUTE FUNCTION finance_os.credit_history_immutable();
CREATE FUNCTION finance_os.validate_balance_observation() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE a record; BEGIN
 SELECT * INTO a FROM finance_os.bank_accounts WHERE id=NEW.bank_account_id;
 IF a.currency<>NEW.currency OR a.classification='unknown' OR (NEW.metric LIKE 'cash_%')<>(a.classification='cash_current') THEN RAISE EXCEPTION 'Balance kind/currency incompatible with account classification'; END IF;
 IF NOT EXISTS(SELECT 1 FROM finance_os.evidence WHERE id=NEW.evidence_id AND file_version=NEW.evidence_file_version) OR NOT NEW.provenance ? 'locator' THEN RAISE EXCEPTION 'Balance evidence/version/locator required'; END IF;
 RETURN NEW; END $$;
CREATE TRIGGER bank_balance_classification BEFORE INSERT ON finance_os.bank_balance_observations FOR EACH ROW EXECUTE FUNCTION finance_os.validate_balance_observation();
COMMIT;
