CREATE TABLE IF NOT EXISTS research_field_transcripts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 interview_id uuid NOT NULL REFERENCES research_field_interviews(id) ON DELETE CASCADE,
 question_key text NOT NULL,
 audio_object_key text NOT NULL,
 model text NOT NULL DEFAULT 'gpt-transcribe',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','processing','draft','approved','failed','obsolete')),
 original_text text,
 edited_text text,
 error_message text,
 attempts integer NOT NULL DEFAULT 0,
 revision integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(),
 started_at timestamptz,
 completed_at timestamptz,
 approved_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(interview_id, question_key, audio_object_key)
);
CREATE INDEX IF NOT EXISTS research_field_transcripts_queue ON research_field_transcripts(status, created_at);
