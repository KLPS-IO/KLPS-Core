CREATE SCHEMA IF NOT EXISTS data_room;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS data_room.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  role text NOT NULL CHECK (
    role IN (
      'founder_admin',
      'authorised_user',
      'pending_user',
      'revoked_user'
    )
  ),
  authorised_at timestamptz,
  authorised_by uuid REFERENCES data_room.users(id),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES data_room.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_room.login_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  ip_address inet,
  success boolean NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_room.login_otps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES data_room.users(id),
  email text NOT NULL,
  otp_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_room.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES data_room.users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  ip_address inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_room.nda_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  company_name text NOT NULL,
  company_number text,
  registered_office_address text,
  watermark_footer_text text NOT NULL,
  agreement_text text NOT NULL,
  agreement_text_hash text NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS data_room.nda_acceptances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES data_room.users(id),
  email text NOT NULL,
  nda_version text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text,
  agreement_text_hash text NOT NULL,
  scroll_completion_required boolean NOT NULL DEFAULT true,
  acceptance_method text NOT NULL DEFAULT 'clickwrap',
  accepted_button_label text NOT NULL DEFAULT 'I agree',
  UNIQUE (user_id, nda_version)
);

CREATE TABLE IF NOT EXISTS data_room.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  category text NOT NULL,
  file_size bigint NOT NULL DEFAULT 0,
  version text NOT NULL,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  storage_path text NOT NULL,
  access_level text NOT NULL DEFAULT 'authorised_user',
  watermark_required boolean NOT NULL DEFAULT true,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS data_room.access_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES data_room.users(id),
  email text,
  event_type text NOT NULL CHECK (
    event_type IN (
      'login_success',
      'login_failed',
      'logout',
      'nda_viewed',
      'nda_accepted',
      'document_viewed',
      'document_downloaded',
      'user_authorised',
      'user_revoked'
    )
  ),
  document_id uuid REFERENCES data_room.documents(id),
  timestamp timestamptz NOT NULL DEFAULT now(),
  ip_address inet,
  user_agent text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_data_room_users_email
  ON data_room.users (email);

CREATE INDEX IF NOT EXISTS idx_data_room_sessions_token_hash
  ON data_room.sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_data_room_access_events_timestamp
  ON data_room.access_events (timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_data_room_access_events_document
  ON data_room.access_events (document_id, timestamp DESC);

CREATE OR REPLACE FUNCTION data_room.prevent_access_event_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'data_room.access_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS access_events_no_update ON data_room.access_events;
CREATE TRIGGER access_events_no_update
BEFORE UPDATE ON data_room.access_events
FOR EACH ROW EXECUTE FUNCTION data_room.prevent_access_event_mutation();

DROP TRIGGER IF EXISTS access_events_no_delete ON data_room.access_events;
CREATE TRIGGER access_events_no_delete
BEFORE DELETE ON data_room.access_events
FOR EACH ROW EXECUTE FUNCTION data_room.prevent_access_event_mutation();

INSERT INTO data_room.users (
  email,
  role,
  authorised_at
)
VALUES (
  'emmamendez07@gmail.com',
  'founder_admin',
  now()
)
ON CONFLICT (email)
DO UPDATE SET
  role = 'founder_admin',
  authorised_at = COALESCE(data_room.users.authorised_at, now()),
  revoked_at = NULL,
  updated_at = now();

INSERT INTO data_room.nda_versions (
  version,
  company_name,
  company_number,
  registered_office_address,
  watermark_footer_text,
  agreement_text,
  agreement_text_hash,
  active
)
VALUES (
  'KLPS NDA V1.0 - May 2026',
  'KLPS Ltd',
  NULL,
  NULL,
  'Confidential Property of KLPS Ltd',
  'KLPS Ltd Innovation Lab / Investor Data Room Non-Disclosure Agreement. The recipient agrees to keep all data room materials confidential, use them only to evaluate KLPS Ltd, and not disclose, copy, reverse engineer, or distribute the materials without prior written consent. This agreement applies to all documents, product materials, financial information, strategy, technical information, and communications made available through the KLPS Innovation Lab / Investor Data Room.',
  encode(digest('KLPS Ltd Innovation Lab / Investor Data Room Non-Disclosure Agreement. The recipient agrees to keep all data room materials confidential, use them only to evaluate KLPS Ltd, and not disclose, copy, reverse engineer, or distribute the materials without prior written consent. This agreement applies to all documents, product materials, financial information, strategy, technical information, and communications made available through the KLPS Innovation Lab / Investor Data Room.', 'sha256'), 'hex'),
  true
)
ON CONFLICT (version)
DO UPDATE SET
  company_name = EXCLUDED.company_name,
  watermark_footer_text = EXCLUDED.watermark_footer_text,
  agreement_text = EXCLUDED.agreement_text,
  agreement_text_hash = EXCLUDED.agreement_text_hash,
  active = true;
