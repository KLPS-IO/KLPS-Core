BEGIN;
CREATE FUNCTION finance_os.validate_bank_transfer_pair() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE t record; other record; BEGIN
 SELECT * INTO t FROM finance_os.bank_transactions WHERE id=NEW.id;
 IF TG_OP='UPDATE' AND OLD.counterpart_transaction_id IS NOT NULL AND OLD.counterpart_transaction_id IS DISTINCT FROM t.counterpart_transaction_id AND EXISTS(SELECT 1 FROM finance_os.bank_transactions WHERE id=OLD.counterpart_transaction_id AND counterpart_transaction_id=t.id) THEN RAISE EXCEPTION 'Cannot leave a one-sided transfer'; END IF;
 IF t.match_kind='transfer' THEN
 SELECT * INTO other FROM finance_os.bank_transactions WHERE id=t.counterpart_transaction_id;
 IF other.id IS NULL OR other.counterpart_transaction_id IS DISTINCT FROM t.id OR other.match_kind IS DISTINCT FROM 'transfer' OR other.currency<>t.currency OR other.amount+t.amount<>0 OR other.bank_account_id=t.bank_account_id OR t.reviewed_by IS NULL OR other.reviewed_by IS NULL THEN RAISE EXCEPTION 'Transfer must be reviewed, reciprocal and balanced'; END IF;
 END IF;RETURN NULL;END $$;
CREATE CONSTRAINT TRIGGER bank_transfer_pair AFTER INSERT OR UPDATE ON finance_os.bank_transactions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION finance_os.validate_bank_transfer_pair();
CREATE FUNCTION finance_os.validate_credit_statement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM finance_os.credit_facilities f JOIN finance_os.evidence e ON e.id=NEW.evidence_id WHERE f.id=NEW.facility_id AND f.currency=NEW.currency AND e.file_version=NEW.evidence_file_version) OR NOT NEW.provenance ? 'locator' THEN RAISE EXCEPTION 'Statement currency/evidence/version/locator required'; END IF;
 RETURN NEW;END $$;
CREATE TRIGGER credit_statement_source BEFORE INSERT ON finance_os.credit_statements FOR EACH ROW EXECUTE FUNCTION finance_os.validate_credit_statement();
CREATE FUNCTION finance_os.guard_credit_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM finance_os.bank_accounts WHERE id=NEW.bank_account_id AND classification='revolving_credit' AND currency=NEW.currency) THEN RAISE EXCEPTION 'Credit facility requires classified revolving credit account'; END IF;RETURN NEW;END $$;
CREATE TRIGGER credit_account_kind BEFORE INSERT OR UPDATE ON finance_os.credit_facilities FOR EACH ROW EXECUTE FUNCTION finance_os.guard_credit_account();
CREATE TRIGGER credit_facility_immutable BEFORE UPDATE OR DELETE ON finance_os.credit_facilities FOR EACH ROW EXECUTE FUNCTION finance_os.credit_history_immutable();
COMMIT;
