import crypto from "crypto";
import { pool } from "../storage/postgres.client";
import type { PoolClient } from "pg";

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
  frequency: string[] | null;
  currentSolutions: unknown[];

  ageRange?: string;
  employmentStatus?: string;
  occupation?: string;
  lifeStage?: string;
  incomeBand?: string;

  challengeFrequency?: string;
  confidenceLevel?: number;

  spentMoney?: string;
  spentMoneyOn?: string[];

  wouldUse?: string;
  wouldPay?: string;
  monthlyPrice?: string;

  desiredInsights?: string[];
  otherInsight?: string;
  trustedSource?: string[];
  recordings: VoiceRecordingInput[];
};

const isBodyAreaObject = (
  value: unknown,
): value is Record<
  string,
  {
    concerns?: string[];
    frequency?: string[];
  }
> => typeof value === "object" && value !== null && !Array.isArray(value);

const researchLog = (event: string, details: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({
      event,
      ...details,
    }),
  );
};

export async function submitResearchResponse(
  data: ResearchSubmission,
  participantId: string,
) {
  const client = await pool.connect();

  const surveyResponseId = crypto.randomUUID();

  try {
    await client.query("BEGIN");

    researchLog("PARTICIPANT_INSERT_STARTED", { participantId });

    await client.query(
      `
      INSERT INTO participants (
        id,
        full_name,
        email,
        consent
      )
      VALUES ($1,$2,$3,$4)
      `,
      [participantId, data.fullName, data.email, data.consent],
    );

    researchLog("PARTICIPANT_INSERT_COMPLETE", { participantId });

    researchLog("SURVEY_INSERT_STARTED", {
      participantId,
      surveyResponseId,
    });

    let bodyAreas = data.bodyAreas;

    let concerns = data.concerns;

    let bodyAreaResponses = null;

    if (isBodyAreaObject(data.bodyAreas)) {
      bodyAreaResponses = data.bodyAreas;

      bodyAreas = Object.keys(data.bodyAreas);

      concerns = Object.fromEntries(
        Object.entries(data.bodyAreas).map(([area, value]) => [
          area,
          value.concerns ?? [],
        ]),
      );
    }

    researchLog("BODY_AREA_NORMALIZED", {
      bodyAreas,
      concerns,
      bodyAreaResponses,
    });

    await client.query(
      `
      INSERT INTO survey_responses (
        id,
        participant_id,
        body_areas,
        concerns,
        frequency,
        current_solutions,
        age_range,
        employment_status,
        occupation,
        life_stage,
        income_band,
        challenge_frequency,
        confidence_level,
        spent_money,
        spent_money_on,
        would_use,
        would_pay,
        monthly_price,
        desired_insights,
        other_insight,
        trusted_source,
        body_area_responses
              )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
        $12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
        $22
      )
      `,
      [
        surveyResponseId,
        participantId,
        JSON.stringify(bodyAreas),
        JSON.stringify(concerns),
        data.frequency,
        JSON.stringify(data.currentSolutions),
        data.ageRange ?? null,
        data.employmentStatus ?? null,
        data.occupation ?? null,
        data.lifeStage ?? null,
        data.incomeBand ?? null,
        data.challengeFrequency ?? null,
        data.confidenceLevel ?? null,
        data.spentMoney ?? null,
        JSON.stringify(data.spentMoneyOn ?? []),
        data.wouldUse ?? null,
        data.wouldPay ?? null,
        data.monthlyPrice ?? null,
        JSON.stringify(data.desiredInsights ?? []),
        data.otherInsight ?? null,
        JSON.stringify(data.trustedSource ?? []),
        JSON.stringify(bodyAreaResponses),
      ],
    );

    researchLog("SURVEY_INSERT_COMPLETE", {
      participantId,
      surveyResponseId,
    });

    for (const recording of data.recordings) {
      const voiceRecordingId = crypto.randomUUID();

      researchLog("VOICE_RECORDING_INSERT_STARTED", {
        participantId,
        surveyResponseId,
        voiceRecordingId,
        questionKey: recording.questionKey,
      });

      await client.query(
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
          voiceRecordingId,
          participantId,
          surveyResponseId,
          recording.questionKey,
          recording.questionText,
          recording.durationSeconds,
          recording.r2ObjectKey,
        ],
      );

      researchLog("VOICE_RECORDING_INSERT_COMPLETE", {
        participantId,
        surveyResponseId,
        voiceRecordingId,
        questionKey: recording.questionKey,
      });
    }

    await client.query("COMMIT");
  } catch (error) {
    await rollbackQuietly(client);
    throw error;
  } finally {
    client.release();
  }

  return {
    participantId,
    surveyResponseId,
  };
}

const rollbackQuietly = async (client: PoolClient) => {
  try {
    await client.query("ROLLBACK");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "RESEARCH_ROLLBACK_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
};
