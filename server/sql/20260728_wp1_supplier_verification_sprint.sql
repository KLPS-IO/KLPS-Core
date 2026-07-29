BEGIN;

ALTER TABLE rd_lab.suppliers
  ADD COLUMN IF NOT EXISTS organisation_aliases text[] NOT NULL DEFAULT '{}';

ALTER TABLE rd_lab.suppliers
  ADD COLUMN IF NOT EXISTS founder_review_required boolean
  GENERATED ALWAYS AS (
    procurement_status IN (
      'Shortlisted',
      'Meeting Booked',
      'Discovery Complete',
      'RFQ Planned',
      'Reserve'
    )
  ) STORED;

-- Abort before changing constraints or inserting records if an existing or
-- proposed canonical name/known identity collides within the same work package.
DO $$
DECLARE
  collisions text;
BEGIN
  WITH proposed (
    work_package_id,
    supplier_id,
    canonical_name,
    aliases
  ) AS (
    SELECT
      wp.id,
      NULL::uuid,
      seed.canonical_name,
      seed.aliases
    FROM rd_lab.work_packages wp
    CROSS JOIN (
      VALUES
        (
          'Interactive Wear AG'::text,
          ARRAY['Interactive Wear']::text[]
        ),
        (
          'Ohmatex A/S'::text,
          ARRAY['Ohmatex', 'Ohmatex ApS']::text[]
        )
    ) AS seed(canonical_name, aliases)
    WHERE wp.code = 'WP1'
      AND NOT EXISTS (
        SELECT 1
        FROM rd_lab.suppliers existing
        WHERE existing.work_package_id = wp.id
          AND lower(btrim(existing.organisation_name)) =
            lower(btrim(seed.canonical_name))
      )
  ),
  identities AS (
    SELECT
      supplier.work_package_id,
      supplier.id AS supplier_id,
      supplier.organisation_name AS canonical_name,
      lower(btrim(identity.value)) AS identity_key
    FROM rd_lab.suppliers supplier
    CROSS JOIN LATERAL unnest(
      ARRAY[supplier.organisation_name] || supplier.organisation_aliases
    ) AS identity(value)

    UNION ALL

    SELECT
      proposed.work_package_id,
      proposed.supplier_id,
      proposed.canonical_name,
      lower(btrim(identity.value)) AS identity_key
    FROM proposed
    CROSS JOIN LATERAL unnest(
      ARRAY[proposed.canonical_name] || proposed.aliases
    ) AS identity(value)
  ),
  invalid_identities AS (
    SELECT
      work_package_id,
      identity_key,
      string_agg(
        canonical_name ||
          CASE
            WHEN supplier_id IS NULL THEN ' [proposed]'
            ELSE ' [' || supplier_id::text || ']'
          END,
        ', '
        ORDER BY canonical_name
      ) AS records
    FROM identities
    GROUP BY work_package_id, identity_key
    HAVING
      identity_key = ''
      OR count(*) > 1
  )
  SELECT string_agg(
    format(
      'work_package=%s identity=%L records=%s',
      work_package_id,
      identity_key,
      records
    ),
    E'\n'
    ORDER BY work_package_id, identity_key
  )
  INTO collisions
  FROM invalid_identities;

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION 'Supplier identity collision detected. Founder review is required.'
      USING
        ERRCODE = '23505',
        DETAIL = collisions,
        HINT = 'Resolve canonical-name and known-identity collisions explicitly; the migration does not merge or rename supplier records.';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION rd_lab.enforce_supplier_identity_uniqueness()
RETURNS trigger AS $$
DECLARE
  submitted_identities text[];
  collision_id uuid;
  collision_name text;
  collision_identity text;
BEGIN
  -- Serialise identity checks per work package so concurrent inserts cannot
  -- pass the check with the same canonical name or alias.
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.work_package_id::text, 20260728)
  );

  SELECT array_agg(lower(btrim(identity.value)))
  INTO submitted_identities
  FROM unnest(
    ARRAY[NEW.organisation_name] || coalesce(NEW.organisation_aliases, '{}')
  ) AS identity(value);

  IF EXISTS (
    SELECT 1
    FROM unnest(submitted_identities) AS identity(value)
    WHERE identity.value = ''
  ) THEN
    RAISE EXCEPTION 'Supplier canonical names and known identities cannot be blank.'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*)
    FROM unnest(submitted_identities) AS identity(value)
  ) <> (
    SELECT count(DISTINCT identity.value)
    FROM unnest(submitted_identities) AS identity(value)
  ) THEN
    RAISE EXCEPTION 'A supplier canonical name and its known identities must be unique.'
      USING ERRCODE = '23505';
  END IF;

  SELECT
    supplier.id,
    supplier.organisation_name,
    shared_identity.value AS identity_key
  INTO collision_id, collision_name, collision_identity
  FROM rd_lab.suppliers supplier
  CROSS JOIN LATERAL unnest(
    ARRAY[supplier.organisation_name] ||
      coalesce(supplier.organisation_aliases, '{}')
  ) AS existing_identity(value)
  CROSS JOIN LATERAL unnest(submitted_identities) AS shared_identity(value)
  WHERE supplier.work_package_id = NEW.work_package_id
    AND supplier.id IS DISTINCT FROM NEW.id
    AND lower(btrim(existing_identity.value)) = shared_identity.value
  LIMIT 1;

  IF collision_id IS NOT NULL THEN
    RAISE EXCEPTION 'Supplier identity already belongs to another canonical supplier.'
      USING
        ERRCODE = '23505',
        DETAIL = format(
          'identity=%L existing_supplier=%s existing_name=%L',
          collision_identity,
          collision_id,
          collision_name
        ),
        HINT = 'Founder review is required. Records are never merged or renamed automatically.';
  END IF;

  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS suppliers_identity_uniqueness
  ON rd_lab.suppliers;

CREATE TRIGGER suppliers_identity_uniqueness
BEFORE INSERT OR UPDATE OF
  work_package_id,
  organisation_name,
  organisation_aliases
ON rd_lab.suppliers
FOR EACH ROW
EXECUTE FUNCTION rd_lab.enforce_supplier_identity_uniqueness();

ALTER TABLE rd_lab.suppliers
  DROP CONSTRAINT IF EXISTS suppliers_procurement_status_check;

-- Legacy values remain valid and unchanged. Ambiguous historical values are
-- exposed through founder_review_required rather than rewritten.
ALTER TABLE rd_lab.suppliers
  ADD CONSTRAINT suppliers_procurement_status_check
  CHECK (procurement_status IN (
    'Researching',
    'Longlisted',
    'Shortlisted',
    'Contacted',
    'Meeting Booked',
    'Discovery Complete',
    'RFQ Planned',
    'RFQ Sent',
    'Quote Received',
    'Declined',
    'Not Suitable',
    'Selected',
    'Reserve',
    'Research',
    'Verified',
    'Discovery Meeting',
    'Comparison',
    'Closed'
  ));

ALTER TABLE rd_lab.suppliers
  ALTER COLUMN procurement_status SET DEFAULT 'Research';

CREATE UNIQUE INDEX IF NOT EXISTS rd_suppliers_wp_organisation_unique
  ON rd_lab.suppliers (work_package_id, lower(btrim(organisation_name)));

-- University of Manchester / GEIC and Henry Royce Institute are intentionally
-- not seeded until their distinct canonical naming has founder approval.
WITH sprint_supplier (
  organisation_name,
  organisation_aliases,
  category,
  country,
  procurement_status,
  source_reference,
  research_notes
) AS (
  VALUES
    (
      'Interactive Wear AG',
      ARRAY['Interactive Wear']::text[],
      'Commercial Smart Textile Developer',
      'Germany',
      'Verified',
      'https://www.interactive-wear.com/',
      E'Verified:\nInteractive Wear AG identity, German location and official source URL verified from the organisation website.\n\nSupplier to Confirm:\nCurrent commercial availability, willingness to participate and fit with the WP1 brief.\n\nUnknown:\nPaid feasibility terms, commercial pricing, prototype capability, SME support, lead times, IP terms, grant eligibility, named contacts and suitability for longitudinal abdominal-change sensing.'
    ),
    (
      'Ohmatex A/S',
      ARRAY['Ohmatex', 'Ohmatex ApS']::text[],
      'Commercial Smart Textile Developer',
      'Denmark',
      'Closed',
      'https://danishaerospace.com/images/docs/Company_Announcement_no.39-11-11-2022_Final2.pdf',
      E'Verified:\nOhmatex identity and Danish location are recorded for Sprint 1. An official Danish Aerospace Company announcement dated 11 November 2022 indicates that Ohmatex was bankrupt and that a specific ESA contract was transferred. The original supplier is no longer an active procurement candidate.\n\nSupplier to Confirm:\nNone while the original organisation remains closed.\n\nUnknown:\nWhether any separate organisation may be relevant to future procurement. Danish Aerospace Company is not inferred to be a successor and has no inherited identity, relationship or procurement history. Any future evaluation requires a completely separate supplier record.'
    )
)
INSERT INTO rd_lab.suppliers (
  work_package_id,
  organisation_name,
  organisation_aliases,
  category,
  country,
  existing_relationship,
  priority_tier,
  procurement_status,
  source_reference,
  research_notes,
  change_reason,
  created_by,
  updated_by
)
SELECT
  wp.id,
  sprint_supplier.organisation_name,
  sprint_supplier.organisation_aliases,
  sprint_supplier.category,
  sprint_supplier.country,
  NULL,
  'Supplier Verification Sprint 1',
  sprint_supplier.procurement_status,
  sprint_supplier.source_reference,
  sprint_supplier.research_notes,
  'Approved Supplier Verification Sprint 1 identity record',
  wp.owner_user_id,
  wp.owner_user_id
FROM rd_lab.work_packages wp
CROSS JOIN sprint_supplier
WHERE wp.code = 'WP1'
ON CONFLICT DO NOTHING;

COMMIT;
