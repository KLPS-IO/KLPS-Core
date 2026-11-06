ALTER TABLE research_field_transcripts ADD COLUMN IF NOT EXISTS speaker_spans jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE research_field_transcripts ADD COLUMN IF NOT EXISTS speakers_reviewed boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN research_field_transcripts.speaker_spans IS 'Manual speaker attribution against edited_text; UTF-16 [start,end) offsets, roles emma/participant/unclear. Empty means unassigned.';
