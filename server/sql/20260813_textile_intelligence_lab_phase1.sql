BEGIN;

CREATE SCHEMA IF NOT EXISTS textile_lab;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE lema.user_profiles
  ADD COLUMN analytics_population text,
  ADD CONSTRAINT lema_user_profiles_analytics_population_check CHECK (
    analytics_population IS NULL OR analytics_population IN ('founder_experiment','controlled_test','real_world_test','genuine_beta')
  );

ALTER TABLE lema.daily_sessions
  ADD COLUMN activity_purpose text,
  ADD COLUMN analytics_population_snapshot text,
  ADD COLUMN analytics_eligible boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT lema_daily_sessions_activity_purpose_check CHECK (
    activity_purpose IS NULL OR activity_purpose IN ('engineering','calibration','controlled_test','real_world_wear','genuine_product_use')
  ),
  ADD CONSTRAINT lema_daily_sessions_population_snapshot_check CHECK (
    analytics_population_snapshot IS NULL OR analytics_population_snapshot IN ('founder_experiment','controlled_test','real_world_test','genuine_beta')
  ),
  ADD CONSTRAINT lema_daily_sessions_traction_integrity_check CHECK (
    analytics_eligible = false OR (
      activity_purpose = 'genuine_product_use'
      AND analytics_population_snapshot IN ('real_world_test','genuine_beta')
    )
  );

CREATE OR REPLACE FUNCTION lema.classify_new_daily_session()
RETURNS trigger AS $$
DECLARE population text;
BEGIN
  SELECT analytics_population INTO population FROM lema.user_profiles WHERE id=NEW.user_id;
  NEW.analytics_population_snapshot := population;
  NEW.activity_purpose := CASE population
    WHEN 'founder_experiment' THEN 'engineering'
    WHEN 'controlled_test' THEN 'controlled_test'
    WHEN 'real_world_test' THEN 'real_world_wear'
    WHEN 'genuine_beta' THEN 'genuine_product_use'
    ELSE NULL
  END;
  NEW.analytics_eligible := population='genuine_beta';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lema_daily_sessions_classify_insert
BEFORE INSERT ON lema.daily_sessions
FOR EACH ROW EXECUTE FUNCTION lema.classify_new_daily_session();

CREATE INDEX lema_daily_sessions_traction_eligible
  ON lema.daily_sessions(created_at,user_id) WHERE analytics_eligible=true;

CREATE TABLE textile_lab.devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_identifier text NOT NULL UNIQUE,
  display_name text NOT NULL,
  hardware_type text NOT NULL,
  hardware_model text NOT NULL,
  firmware_version text,
  transport text NOT NULL CHECK (transport IN ('usb_serial','ble','other')),
  status text NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','connected','disconnected','retired')),
  transport_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_connected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  updated_by uuid NOT NULL REFERENCES data_room.users(id)
);

CREATE TABLE textile_lab.specimens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specimen_identifier text NOT NULL UNIQUE,
  display_name text NOT NULL,
  version text NOT NULL,
  construction_version text,
  sensing_configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('draft','active','testing','retired','archived')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  updated_by uuid NOT NULL REFERENCES data_room.users(id)
);

CREATE TABLE textile_lab.test_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  specimen_id uuid NOT NULL REFERENCES textile_lab.specimens(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES textile_lab.devices(id) ON DELETE RESTRICT,
  test_user_id uuid REFERENCES lema.user_profiles(id) ON DELETE RESTRICT,
  intended_activity_purpose text NOT NULL CHECK (intended_activity_purpose IN ('engineering','calibration','controlled_test','real_world_wear','genuine_product_use')),
  analytics_population_snapshot text CHECK (analytics_population_snapshot IS NULL OR analytics_population_snapshot IN ('founder_experiment','controlled_test','real_world_test','genuine_beta')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  notes text,
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  CHECK (ended_at IS NULL OR ended_at >= assigned_at)
);

CREATE TABLE textile_lab.test_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id uuid REFERENCES textile_lab.test_assignments(id) ON DELETE RESTRICT,
  specimen_id uuid NOT NULL REFERENCES textile_lab.specimens(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES textile_lab.devices(id) ON DELETE RESTRICT,
  test_user_id uuid REFERENCES lema.user_profiles(id) ON DELETE RESTRICT,
  activity_purpose text NOT NULL CHECK (activity_purpose IN ('engineering','calibration','controlled_test','real_world_wear','genuine_product_use')),
  analytics_population_snapshot text CHECK (analytics_population_snapshot IS NULL OR analytics_population_snapshot IN ('founder_experiment','controlled_test','real_world_test','genuine_beta')),
  analytics_eligible boolean NOT NULL DEFAULT false CHECK (analytics_eligible=false),
  protocol_identifier text,
  protocol_version text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('planned','active','completed','aborted')),
  notes text,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE textile_lab.raw_readings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES textile_lab.test_sessions(id) ON DELETE RESTRICT,
  device_id uuid NOT NULL REFERENCES textile_lab.devices(id) ON DELETE RESTRICT,
  specimen_id uuid REFERENCES textile_lab.specimens(id) ON DELETE RESTRICT,
  observed_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  channel_identifier text NOT NULL,
  raw_value text NOT NULL,
  unit text,
  sequence_number bigint,
  adapter_identifier text NOT NULL,
  adapter_version text NOT NULL,
  transport text NOT NULL,
  source_payload text,
  ingestion_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid NOT NULL REFERENCES data_room.users(id),
  UNIQUE (session_id, device_id, sequence_number)
);

CREATE INDEX textile_lab_raw_readings_session_time
  ON textile_lab.raw_readings(session_id, observed_at, id);
CREATE INDEX textile_lab_sessions_state
  ON textile_lab.test_sessions(status, started_at DESC);

CREATE OR REPLACE FUNCTION textile_lab.prevent_raw_reading_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'textile_lab.raw_readings is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER textile_lab_raw_readings_no_update
BEFORE UPDATE ON textile_lab.raw_readings
FOR EACH ROW EXECUTE FUNCTION textile_lab.prevent_raw_reading_mutation();
CREATE TRIGGER textile_lab_raw_readings_no_delete
BEFORE DELETE ON textile_lab.raw_readings
FOR EACH ROW EXECUTE FUNCTION textile_lab.prevent_raw_reading_mutation();

INSERT INTO textile_lab.specimens (
  specimen_identifier,display_name,version,construction_version,notes,status,created_by,updated_by
)
SELECT seed.identifier,seed.name,'1',NULL,seed.notes,'active',u.id,u.id
FROM (SELECT id FROM data_room.users WHERE role='founder_admin' ORDER BY created_at LIMIT 1) u
CROSS JOIN (VALUES
  ('SPECIMEN-01','Founder development garment','Initial founder development specimen.'),
  ('SPECIMEN-02','Prototype User A garment','Not permanently bound to a user identity.'),
  ('SPECIMEN-03','Prototype User B garment','Not permanently bound to a user identity.')
) AS seed(identifier,name,notes)
ON CONFLICT (specimen_identifier) DO NOTHING;

COMMIT;
