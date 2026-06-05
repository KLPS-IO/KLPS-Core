import crypto from "crypto";
import { pool } from "../storage/postgres.client";

export type VoiceRecordingInput = {
  questionKey: string;
  questionText: string;
  durationSeconds: number;
  r2ObjectKey: string;
};

export type ResearchSubmission = {
  fullName: string;
  email: string;
  consent: boolean;

  bodyAreas: unknown;
  concerns: unknown;
  frequency: string | null;
  currentSolutions: unknown;

  recordings: VoiceRecordingInput[];
};

export async function submitResearchResponse(
  data: ResearchSubmission
) {
  const participantId =
    crypto.randomUUID();

  const surveyResponseId =
    crypto.randomUUID();

  await pool.query(
    `
    INSERT INTO participants (
      id,
      full_name,
      email,
      consent
    )
    VALUES ($1,$2,$3,$4)
    `,
    [
      participantId,
      data.fullName,
      data.email,
      data.consent
    ]
  );

  await pool.query(
    `
    INSERT INTO survey_responses (
      id,
      participant_id,
      body_areas,
      concerns,
      frequency,
      current_solutions
    )
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [
      surveyResponseId,
      participantId,
      JSON.stringify(data.bodyAreas),
      JSON.stringify(data.concerns),
      data.frequency,
      JSON.stringify(
        data.currentSolutions
      )
    ]
  );

  for (const recording of data.recordings) {
    await pool.query(
      `
      INSERT INTO voice_recordings (
        id,
        participant_id,
        survey_response_id,
        question_key,
        question_text,
        duration_seconds,
        r2_object_key
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7
      )
      `,
      [
        crypto.randomUUID(),
        participantId,
        surveyResponseId,
        recording.questionKey,
        recording.questionText,
        recording.durationSeconds,
        recording.r2ObjectKey
      ]
    );
  }

  return {
    participantId,
    surveyResponseId
  };
}