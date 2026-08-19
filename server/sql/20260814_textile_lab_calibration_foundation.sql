BEGIN;

ALTER TABLE textile_lab.devices
  ADD COLUMN hardware_revision text,
  ADD COLUMN firmware_identifier text;

CREATE TABLE textile_lab.adapter_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  adapter_identifier text NOT NULL,
  adapter_version text NOT NULL,
  transport text NOT NULL,
  display_name text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(adapter_identifier,adapter_version)
);

CREATE TABLE textile_lab.channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES textile_lab.devices(id) ON DELETE RESTRICT,
  adapter_definition_id uuid REFERENCES textile_lab.adapter_definitions(id) ON DELETE RESTRICT,
  channel_identifier text NOT NULL,
  display_name text NOT NULL,
  raw_data_type text NOT NULL CHECK(raw_data_type IN ('integer','decimal','boolean','text','binary')),
  unit text,
  scale_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  signal_stage text NOT NULL DEFAULT 'raw' CHECK(signal_stage IN ('raw','calibrated','derived')),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  active boolean NOT NULL DEFAULT true,
  hardware_revision_snapshot text,
  firmware_version_snapshot text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(device_id,channel_identifier,version)
);

ALTER TABLE textile_lab.raw_readings
  ADD COLUMN channel_id uuid REFERENCES textile_lab.channels(id) ON DELETE RESTRICT;
CREATE INDEX textile_lab_raw_readings_channel_time ON textile_lab.raw_readings(channel_id,observed_at,id);

CREATE TABLE textile_lab.experiment_protocols (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  protocol_identifier text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  engineering_objective text NOT NULL,
  channel_id uuid REFERENCES textile_lab.channels(id) ON DELETE RESTRICT,
  specimen_requirements jsonb NOT NULL DEFAULT '{}'::jsonb,
  reference_inputs jsonb NOT NULL DEFAULT '[]'::jsonb,
  cycle_count integer CHECK(cycle_count IS NULL OR cycle_count>0),
  baseline_seconds numeric CHECK(baseline_seconds IS NULL OR baseline_seconds>=0),
  hold_seconds numeric CHECK(hold_seconds IS NULL OR hold_seconds>=0),
  acceptance_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','retired')),
  approved_at timestamptz,
  approved_by uuid REFERENCES data_room.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(protocol_identifier,version),
  CHECK((status='approved')=(approved_at IS NOT NULL AND approved_by IS NOT NULL) OR status<>'approved')
);

CREATE TABLE textile_lab.calibration_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_identifier text NOT NULL UNIQUE,
  protocol_id uuid NOT NULL REFERENCES textile_lab.experiment_protocols(id) ON DELETE RESTRICT,
  session_id uuid NOT NULL REFERENCES textile_lab.test_sessions(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES textile_lab.channels(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES textile_lab.devices(id) ON DELETE RESTRICT,
  specimen_id uuid NOT NULL REFERENCES textile_lab.specimens(id) ON DELETE RESTRICT,
  calibration_definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','completed','failed','reviewed')),
  maturity_state text NOT NULL DEFAULT 'CALIBRATING' CHECK(maturity_state IN ('CALIBRATING','EXPERIMENTAL','VALIDATED')),
  passed boolean,
  deviations jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  started_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  CHECK(ended_at IS NULL OR started_at IS NOT NULL AND ended_at>=started_at),
  CHECK(maturity_state<>'VALIDATED')
);

CREATE TABLE textile_lab.reference_observations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_run_id uuid NOT NULL REFERENCES textile_lab.calibration_runs(id) ON DELETE RESTRICT,
  raw_reading_id uuid NOT NULL REFERENCES textile_lab.raw_readings(id) ON DELETE RESTRICT,
  reference_label text NOT NULL,
  reference_value numeric,
  reference_unit text,
  cycle_number integer CHECK(cycle_number IS NULL OR cycle_number>0),
  phase text NOT NULL CHECK(phase IN ('baseline','load','hold','unload','recovery')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(calibration_run_id,raw_reading_id)
);

CREATE TABLE textile_lab.algorithm_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  algorithm_identifier text NOT NULL,
  version text NOT NULL,
  title text NOT NULL,
  result_types text[] NOT NULL,
  implementation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  checksum text,
  status text NOT NULL DEFAULT 'experimental' CHECK(status IN ('experimental','approved','retired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(algorithm_identifier,version)
);

CREATE TABLE textile_lab.derived_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  calibration_run_id uuid NOT NULL REFERENCES textile_lab.calibration_runs(id) ON DELETE RESTRICT,
  protocol_id uuid NOT NULL REFERENCES textile_lab.experiment_protocols(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL REFERENCES textile_lab.channels(id) ON DELETE RESTRICT,
  algorithm_version_id uuid NOT NULL REFERENCES textile_lab.algorithm_versions(id) ON DELETE RESTRICT,
  result_type text NOT NULL CHECK(result_type IN ('baseline_mean','baseline_standard_deviation','baseline_relative_change','normalised_response','repeatability_cv','drift','recovery','hysteresis_indicator','signal_completeness')),
  numeric_value numeric,
  unit text,
  value_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  uncertainty numeric CHECK(uncertainty IS NULL OR uncertainty>=0),
  quality_percentage numeric CHECK(quality_percentage IS NULL OR quality_percentage BETWEEN 0 AND 100),
  maturity_state text NOT NULL DEFAULT 'EXPERIMENTAL' CHECK(maturity_state='EXPERIMENTAL'),
  result_version integer NOT NULL CHECK(result_version>0),
  supersedes_result_id uuid REFERENCES textile_lab.derived_results(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE(calibration_run_id,result_type,result_version)
);

CREATE TABLE textile_lab.result_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  derived_result_id uuid NOT NULL REFERENCES textile_lab.derived_results(id) ON DELETE RESTRICT,
  from_state text NOT NULL CHECK(from_state IN ('EXPERIMENTAL','VALIDATED')),
  to_state text NOT NULL CHECK(to_state IN ('VALIDATED','USER_FACING')),
  decision text NOT NULL CHECK(decision IN ('approved','rejected')),
  criteria_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by uuid NOT NULL REFERENCES data_room.users(id)
);

CREATE OR REPLACE FUNCTION textile_lab.prevent_calibration_history_mutation()
RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'textile_lab calibration history is append-only'; END; $$ LANGUAGE plpgsql;
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['experiment_protocols','reference_observations','algorithm_versions','derived_results','result_reviews'] LOOP
    EXECUTE format('CREATE TRIGGER %I_no_update BEFORE UPDATE ON textile_lab.%I FOR EACH ROW EXECUTE FUNCTION textile_lab.prevent_calibration_history_mutation()',table_name,table_name);
    EXECUTE format('CREATE TRIGGER %I_no_delete BEFORE DELETE ON textile_lab.%I FOR EACH ROW EXECUTE FUNCTION textile_lab.prevent_calibration_history_mutation()',table_name,table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION textile_lab.validate_calibration_run_links()
RETURNS trigger AS $$
DECLARE s textile_lab.test_sessions%ROWTYPE; p textile_lab.experiment_protocols%ROWTYPE; c textile_lab.channels%ROWTYPE;
BEGIN
  SELECT * INTO s FROM textile_lab.test_sessions WHERE id=NEW.session_id;
  SELECT * INTO p FROM textile_lab.experiment_protocols WHERE id=NEW.protocol_id;
  SELECT * INTO c FROM textile_lab.channels WHERE id=NEW.channel_id;
  IF s.id IS NULL OR p.id IS NULL OR c.id IS NULL OR p.status<>'approved' OR s.device_id<>NEW.device_id OR s.specimen_id<>NEW.specimen_id OR c.device_id<>NEW.device_id OR (p.channel_id IS NOT NULL AND p.channel_id<>NEW.channel_id) THEN
    RAISE EXCEPTION 'Calibration run lineage does not match session, specimen, device, protocol and channel';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER calibration_runs_validate_links BEFORE INSERT OR UPDATE ON textile_lab.calibration_runs FOR EACH ROW EXECUTE FUNCTION textile_lab.validate_calibration_run_links();

CREATE OR REPLACE FUNCTION textile_lab.validate_reference_observation()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM textile_lab.calibration_runs cr JOIN textile_lab.raw_readings rr ON rr.id=NEW.raw_reading_id WHERE cr.id=NEW.calibration_run_id AND rr.session_id=cr.session_id AND rr.device_id=cr.device_id AND rr.specimen_id=cr.specimen_id AND (rr.channel_id=cr.channel_id OR rr.channel_id IS NULL AND rr.channel_identifier=(SELECT channel_identifier FROM textile_lab.channels WHERE id=cr.channel_id))) THEN
    RAISE EXCEPTION 'Reference observation does not belong to the calibration run lineage';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER reference_observations_validate BEFORE INSERT ON textile_lab.reference_observations FOR EACH ROW EXECUTE FUNCTION textile_lab.validate_reference_observation();

CREATE OR REPLACE FUNCTION textile_lab.validate_derived_result_lineage()
RETURNS trigger AS $$
BEGIN
  IF NEW.maturity_state<>'EXPERIMENTAL' OR NOT EXISTS(SELECT 1 FROM textile_lab.calibration_runs cr WHERE cr.id=NEW.calibration_run_id AND cr.protocol_id=NEW.protocol_id AND cr.channel_id=NEW.channel_id) THEN RAISE EXCEPTION 'Derived result lineage or maturity is invalid'; END IF;
  IF NEW.supersedes_result_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM textile_lab.derived_results previous WHERE previous.id=NEW.supersedes_result_id AND previous.calibration_run_id=NEW.calibration_run_id AND previous.result_type=NEW.result_type AND previous.result_version<NEW.result_version) THEN RAISE EXCEPTION 'Superseded result is not an earlier compatible version'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER derived_results_validate BEFORE INSERT ON textile_lab.derived_results FOR EACH ROW EXECUTE FUNCTION textile_lab.validate_derived_result_lineage();

CREATE OR REPLACE FUNCTION textile_lab.validate_result_review()
RETURNS trigger AS $$
DECLARE current_state text; run_passed boolean;
BEGIN
  SELECT COALESCE((SELECT rr.to_state FROM textile_lab.result_reviews rr WHERE rr.derived_result_id=NEW.derived_result_id AND rr.decision='approved' ORDER BY rr.reviewed_at DESC,rr.id DESC LIMIT 1),dr.maturity_state),cr.passed INTO current_state,run_passed FROM textile_lab.derived_results dr JOIN textile_lab.calibration_runs cr ON cr.id=dr.calibration_run_id WHERE dr.id=NEW.derived_result_id;
  IF NEW.from_state<>current_state THEN RAISE EXCEPTION 'Review from_state does not match canonical current state'; END IF;
  IF NEW.to_state='USER_FACING' THEN RAISE EXCEPTION 'USER_FACING is locked in calibration foundation phase'; END IF;
  IF NEW.to_state<>'VALIDATED' OR NEW.from_state<>'EXPERIMENTAL' OR NEW.decision='approved' AND (run_passed IS DISTINCT FROM true OR NEW.criteria_evidence='{}'::jsonb) THEN RAISE EXCEPTION 'Result cannot skip maturity stages or validate without passed criteria'; END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER result_reviews_validate BEFORE INSERT ON textile_lab.result_reviews FOR EACH ROW EXECUTE FUNCTION textile_lab.validate_result_review();

ALTER TABLE finance_os.evidence_links DROP CONSTRAINT IF EXISTS evidence_links_entity_type_check;
ALTER TABLE finance_os.evidence_links ADD CONSTRAINT evidence_links_entity_type_check CHECK(entity_type IN (
  'assumption','product','decision','risk','company','funding','kpi','report','scenario','hire','document','expense','expense_adjustment','vat_filing',
  'rd_work_package','rd_supplier','rd_interaction','rd_finding','rd_action','rd_rfq','rd_quotation',
  'textile_protocol','textile_session','textile_calibration_run','textile_derived_result'
));

INSERT INTO textile_lab.adapter_definitions(adapter_identifier,adapter_version,transport,display_name,created_by)
SELECT 'arduino-usb-serial','1.1.0','usb_serial','Arduino USB serial adapter',id FROM data_room.users WHERE role='founder_admin' ORDER BY created_at LIMIT 1
ON CONFLICT(adapter_identifier,adapter_version) DO NOTHING;

INSERT INTO textile_lab.channels(device_id,adapter_definition_id,channel_identifier,display_name,raw_data_type,signal_stage,hardware_revision_snapshot,firmware_version_snapshot,created_by)
SELECT d.id,a.id,'electrical_raw_a0','A0 electrical raw channel','decimal','raw',d.hardware_revision,d.firmware_version,u.id
FROM textile_lab.devices d JOIN textile_lab.adapter_definitions a ON a.adapter_identifier='arduino-usb-serial' AND a.adapter_version='1.1.0'
CROSS JOIN LATERAL(SELECT id FROM data_room.users WHERE role='founder_admin' ORDER BY created_at LIMIT 1)u
WHERE d.device_identifier='ARDUINO-01'
ON CONFLICT(device_id,channel_identifier,version) DO NOTHING;

COMMIT;
