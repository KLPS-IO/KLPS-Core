CREATE TABLE IF NOT EXISTS research_field_interviews (
 id uuid PRIMARY KEY,
 created_at timestamptz NOT NULL DEFAULT now(),
 payload jsonb NOT NULL
);
COMMENT ON TABLE research_field_interviews IS 'Private founder-only consented field interviews; separate from public survey. Review retention and remove contact details when follow-up is complete.';
