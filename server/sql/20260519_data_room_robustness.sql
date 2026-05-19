ALTER TABLE data_room.users
ADD COLUMN IF NOT EXISTS access_tier text NOT NULL DEFAULT 'investor_nda';

ALTER TABLE data_room.users
DROP CONSTRAINT IF EXISTS users_access_tier_check;

ALTER TABLE data_room.users
ADD CONSTRAINT users_access_tier_check
CHECK (
  access_tier IN (
    'public_light',
    'investor_nda',
    'advisor_nda',
    'founder_only',
    'legal_only',
    'admin_only'
  )
);

UPDATE data_room.users
SET access_tier = 'admin_only'
WHERE role = 'founder_admin';

ALTER TABLE data_room.documents
ADD COLUMN IF NOT EXISTS description text,
ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS storage_provider text NOT NULL DEFAULT 'local',
ADD COLUMN IF NOT EXISTS content_type text;

ALTER TABLE data_room.documents
ALTER COLUMN access_level SET DEFAULT 'investor_nda';

UPDATE data_room.documents
SET access_level = 'investor_nda'
WHERE access_level = 'authorised_user';

UPDATE data_room.documents
SET access_level = 'admin_only'
WHERE access_level = 'founder_admin';

ALTER TABLE data_room.documents
DROP CONSTRAINT IF EXISTS documents_access_level_check;

ALTER TABLE data_room.documents
ADD CONSTRAINT documents_access_level_check
CHECK (
  access_level IN (
    'public_light',
    'investor_nda',
    'advisor_nda',
    'founder_only',
    'legal_only',
    'admin_only'
  )
);

ALTER TABLE data_room.documents
DROP CONSTRAINT IF EXISTS documents_storage_provider_check;

ALTER TABLE data_room.documents
ADD CONSTRAINT documents_storage_provider_check
CHECK (
  storage_provider IN (
    'local',
    'r2'
  )
);

CREATE TABLE IF NOT EXISTS data_room.document_categories (
  id text PRIMARY KEY,
  label text NOT NULL,
  description text,
  sort_order integer NOT NULL,
  minimum_access_level text NOT NULL DEFAULT 'investor_nda',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    minimum_access_level IN (
      'public_light',
      'investor_nda',
      'advisor_nda',
      'founder_only',
      'legal_only',
      'admin_only'
    )
  )
);

INSERT INTO data_room.document_categories (
  id,
  label,
  description,
  sort_order,
  minimum_access_level
)
VALUES
  ('01_company_overview', '01 Company Overview', 'START_HERE, company summary, founder bio, vision and current stage.', 10, 'public_light'),
  ('02_pitch_deck', '02 Pitch Deck', 'Current investor deck and supporting one-pagers.', 20, 'public_light'),
  ('03_product_and_technology', '03 Product and Technology', 'Approved product, architecture and technical feasibility materials.', 30, 'investor_nda'),
  ('04_ip_and_defensibility', '04 IP and Defensibility', 'IP strategy, invention summaries, prior art and defensibility notes.', 40, 'investor_nda'),
  ('05_market_and_customers', '05 Market and Customers', 'Market sizing, customer profiles, positioning and CRM-safe summaries.', 50, 'investor_nda'),
  ('06_financials', '06 Financials', 'Financial planning, use of funds, milestones and commercial assumptions.', 60, 'investor_nda'),
  ('07_validation_and_programmes', '07 Validation and Programmes', 'Grant applications, programme evidence, university and expert validation.', 70, 'investor_nda'),
  ('08_brand_assets', '08 Brand Assets', 'Approved logos, media kit, imagery and marketing materials.', 80, 'public_light'),
  ('09_legal_and_compliance', '09 Legal and Compliance', 'Legal, compliance and diligence materials for approved reviewers.', 90, 'legal_only'),
  ('10_founder_only', '10 Founder Only', 'Internal vault for sensitive IP, raw CRM, private notes and operational material.', 100, 'founder_only')
ON CONFLICT (id)
DO UPDATE SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  minimum_access_level = EXCLUDED.minimum_access_level,
  active = true;

CREATE INDEX IF NOT EXISTS idx_data_room_documents_access
  ON data_room.documents (active, access_level, category, sort_order);
