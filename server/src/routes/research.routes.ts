import { Router } from "express";
import multer from "multer";
import { uploadToR2 } from "../services/r2.service";
import { submitResearchResponse } from "../services/research.service";
import { pool } from "../storage/postgres.client";
import crypto from "crypto";
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
});

const voiceUpload = upload.fields([
  {
    name: "voice_0",
    maxCount: 1,
  },
  {
    name: "voice_1",
    maxCount: 1,
  },
  {
    name: "voice_2",
    maxCount: 1,
  },
  {
    name: "voice_3",
    maxCount: 1,
  },
]);

type VoiceField = "voice_0" | "voice_1" | "voice_2" | "voice_3";

type UploadedResearchFile = {
  file: Express.Multer.File;
  objectKey: string;
};

const researchLog = (event: string, details: Record<string, unknown> = {}) => {
  console.log(
    JSON.stringify({
      event,
      ...details,
    }),
  );
};

const asString = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";

const asStringArray = (value: unknown) =>
  Array.isArray(value)
    ? value
        .filter((item) => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

const asBoolean = (value: unknown) => value === true || value === "true";

const asNumber = (value: unknown) => {
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
};

const asOptionalNumber = (value: unknown) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : undefined;
};

const parsePayload = (rawPayload: unknown) => {
  if (typeof rawPayload !== "string") {
    throw new Error("Missing research payload");
  }

  try {
    return JSON.parse(rawPayload) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid research payload");
  }
};

const getRecordingMetadata = (
  payload: Record<string, unknown>,
  index: number,
) => {
  const candidates = [payload.voiceRecordings, payload.recordings];

  for (const candidate of candidates) {
    if (
      Array.isArray(candidate) &&
      candidate[index] &&
      typeof candidate[index] === "object"
    ) {
      return candidate[index] as Record<string, unknown>;
    }
  }

  return {};
};

const getQuestionKeyFromFile = (file: Express.Multer.File) =>
  file.originalname.replace(/\.[^.]+$/, "");

const getFieldIndex = (fieldname: string) => {
  const match = /^voice_(\d+)$/.exec(fieldname);

  return match ? Number(match[1]) : 0;
};

router.post("/", voiceUpload, async (req, res) => {
  try {
    researchLog("RESEARCH_REQUEST_RECEIVED", {
      contentType: req.header("content-type"),
      fields: Object.keys(req.body ?? {}),
    });

    const payload = parsePayload(req.body?.payload);

    const participantId = crypto.randomUUID();

    const filesByField = (req.files ?? {}) as Partial<
      Record<VoiceField, Express.Multer.File[]>
    >;

    const files = [
      ...(filesByField.voice_0 ?? []),
      ...(filesByField.voice_1 ?? []),
      ...(filesByField.voice_2 ?? []),
      ...(filesByField.voice_3 ?? []),
    ];

    const uploadedFiles = await Promise.all(
      (files ?? []).map(async (file) => {
        const objectKey = `research/survey-responses/${participantId}/${Date.now()}-${file.originalname}`;
        researchLog("R2_UPLOAD_STARTED", {
          fieldname: file.fieldname,
          originalname: file.originalname,
          objectKey,
        });

        await uploadToR2(objectKey, file.buffer, file.mimetype);

        researchLog("R2_UPLOAD_COMPLETE", {
          fieldname: file.fieldname,
          originalname: file.originalname,
          objectKey,
        });

        return {
          file,
          objectKey,
        };
      }),
    );

    const submission = await submitResearchResponse(
      {
        bodyType: asString(payload.bodyType) || undefined,
        otherBodyType: asString(payload.otherBodyType) || undefined,
        fullName: asString(payload.fullName),
        email: asString(payload.email).toLowerCase(),
        consent: asBoolean(payload.consent),
        bodyAreas: payload.bodyAreas ?? {},
        concerns: payload.concerns ?? {},
        frequency: null,
        currentSolutions: asStringArray(payload.currentSolutions),
        ageRange: asString(payload.ageRange) || undefined,
        employmentStatus: asString(payload.employmentStatus) || undefined,
        occupation: asString(payload.occupation) || undefined,
        lifeStage: asString(payload.lifeStage) || undefined,
        incomeBand: asString(payload.incomeBand) || undefined,
        challengeFrequency: asString(payload.challengeFrequency) || undefined,
        confidenceLevel: asOptionalNumber(payload.confidenceLevel),
        spentMoney: asString(payload.spentMoney) || undefined,
        spentMoneyOn: asStringArray(payload.spentMoneyOn),
        otherSpentMoney: asString(payload.otherSpentMoney) || undefined,
        wouldUse: asString(payload.wouldUse) || undefined,
        wouldPay: asString(payload.wouldPay) || undefined,
        monthlyPrice: asString(payload.monthlyPrice) || undefined,
        desiredInsights: asStringArray(payload.desiredInsights),
        otherInsight: asString(payload.otherInsight) || undefined,
        trustedSource: asStringArray(
          payload.trustedSource ?? payload.trusted_source,
        ),
        recordings:
          uploadedFiles.length > 0
            ? uploadedFiles.map((uploadedFile) =>
                toRecordingInput(payload, uploadedFile),
              )
            : Array.isArray(payload.voiceRecordings)
              ? payload.voiceRecordings.map((recording) => ({
                  questionKey: asString(recording.questionKey),
                  questionText: asString(recording.questionText),
                  durationSeconds: Math.round(
                    asNumber(recording.durationSeconds),
                  ),
                  typedResponse: asString(recording.typedResponse) || undefined,
                }))
              : [],
      },
      participantId,
    );

    researchLog("RESEARCH_SUBMISSION_COMPLETE", {
      participantId: submission.participantId,
      surveyResponseId: submission.surveyResponseId,
      recordingCount: uploadedFiles.length,
    });

    const objectKeys = uploadedFiles.map(
      (uploadedFile) => uploadedFile.objectKey,
    );

    return res.json({
      success: true,
      participantId: submission.participantId,
      surveyResponseId: submission.surveyResponseId,
      objectKey: objectKeys[0] ?? null,
      objectKeys,
    });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "RESEARCH_SUBMISSION_FAILED",
        error: error instanceof Error ? error.message : String(error),
      }),
    );

    if (
      error instanceof Error &&
      (error.message === "Missing research payload" ||
        error.message === "Invalid research payload")
    ) {
      return res.status(400).json({
        success: false,
        error: error.message,
      });
    }

    return res.status(500).json({
      success: false,
      error: "Research submission failed",
    });
  }
});

const toRecordingInput = (
  payload: Record<string, unknown>,
  uploadedFile: UploadedResearchFile,
) => {
  const index = getFieldIndex(uploadedFile.file.fieldname);

  const metadata = getRecordingMetadata(payload, index);

  return {
    questionKey:
      asString(metadata.questionKey) ||
      getQuestionKeyFromFile(uploadedFile.file),

    questionText: asString(metadata.questionText),

    durationSeconds: Math.round(asNumber(metadata.durationSeconds)),

    r2ObjectKey: uploadedFile.objectKey,

    typedResponse: asString(metadata.typedResponse) || undefined,
  };
};

router.get("/metrics", async (_req, res) => {
  try {
    const result = await pool.query(
      `
        WITH totals AS (
          SELECT
            COUNT(*)::int AS participants
          FROM participants
        ),
        top_concern AS (
          SELECT
            concern,
            response_count AS count
          FROM research_concern_counts
          ORDER BY response_count DESC, concern ASC
          LIMIT 1
        ),
        top_concerns AS (
          SELECT
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'value',
                  concern,
                  'count',
                  response_count
                )
                ORDER BY response_count DESC, concern ASC
              ),
              '[]'::jsonb
            ) AS value
          FROM (
            SELECT
              concern,
              response_count
            FROM research_concern_counts
            ORDER BY response_count DESC, concern ASC
            LIMIT 5
          ) ranked
        ),
        desired_insight_values AS (
          SELECT
            insight
          FROM survey_responses
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(desired_insights) = 'array'
              THEN desired_insights
              ELSE '[]'::jsonb
            END
          ) AS insight
        ),
        top_desired_insights AS (
          SELECT
            COALESCE(
              jsonb_agg(
                jsonb_build_object(
                  'value',
                  insight,
                  'count',
                  count
                )
                ORDER BY count DESC, insight ASC
              ),
              '[]'::jsonb
            ) AS value
          FROM (
            SELECT
              insight,
              COUNT(*)::int AS count
            FROM desired_insight_values
            GROUP BY insight
            ORDER BY count DESC, insight ASC
            LIMIT 5
          ) ranked
        ),
      trusted_sources AS (
        SELECT
          COALESCE(
            jsonb_agg(
              jsonb_build_object(
                'value',
                source,
                'count',
                response_count
              )
              ORDER BY response_count DESC, source ASC
            ),
            '[]'::jsonb
          ) AS value
        FROM (
          SELECT
            source,
            response_count
          FROM research_trusted_source_counts
          ORDER BY response_count DESC, source ASC
          LIMIT 5
        ) ranked
      ),
      price_point_counts AS (
        SELECT
          monthly_price,
          COUNT(*)::int AS count
        FROM survey_responses
        WHERE monthly_price IS NOT NULL
        GROUP BY monthly_price
      ),

      top_price_point AS (
        SELECT
          monthly_price,
          count
        FROM price_point_counts
        ORDER BY count DESC
        LIMIT 1
      )
      SELECT
          totals.participants,

          (
            SELECT COUNT(DISTINCT participant_id)::int
            FROM voice_recordings
          ) AS "voiceRecordings",

          top_concern.concern AS "topConcern",

          CASE
            WHEN totals.participants = 0
            THEN 0
            ELSE ROUND(
              top_concern.count * 100.0 /
              totals.participants
            )::int
          END AS "topConcernPercent",
          CASE
            WHEN totals.participants = 0
            THEN 0
            ELSE ROUND(
              COUNT(*) FILTER (
                WHERE LOWER(
                  COALESCE(
                    survey_responses.spent_money,
                    ''
                  )
                ) IN ('yes', 'true', 'y')
              ) * 100.0 / totals.participants
            )::int
          END AS "spentMoneyPercent",
        COUNT(*) FILTER (
          WHERE LOWER(
            COALESCE(
              survey_responses.would_pay,
              ''
            )
          ) IN ('yes', 'true', 'y')
        )::int AS "yesCount",

        COUNT(*) FILTER (
          WHERE LOWER(
            COALESCE(
              survey_responses.would_pay,
              ''
            )
          ) = 'maybe'
        )::int AS "maybeCount",

        COUNT(*) FILTER (
          WHERE LOWER(
            COALESCE(
              survey_responses.would_pay,
              ''
            )
          ) = 'no'
        )::int AS "noCount",

        COUNT(*) FILTER (
          WHERE LOWER(
            COALESCE(
              survey_responses.would_pay,
              ''
            )
          ) IN ('yes', 'true', 'y', 'maybe')
        )::int AS "commercialInterestCount",

        CASE
          WHEN totals.participants = 0
          THEN 0
          ELSE ROUND(
            COUNT(*) FILTER (
              WHERE LOWER(
                COALESCE(
                  survey_responses.would_pay,
                  ''
                )
              ) IN ('yes', 'true', 'y', 'maybe')
            ) * 100.0 / totals.participants
          )::int
        END AS "commercialInterestPercent",
          top_concerns.value AS "topConcerns",
          top_desired_insights.value AS "topDesiredInsights",
          trusted_sources.value AS "trustedSources",
          top_price_point.monthly_price AS "topPricePoint",
          top_price_point.count AS "topPricePointCount"
        FROM totals
        CROSS JOIN top_concerns
        CROSS JOIN top_desired_insights
        CROSS JOIN trusted_sources
        CROSS JOIN top_price_point
        LEFT JOIN top_concern ON true
        LEFT JOIN survey_responses ON true
        GROUP BY
          totals.participants,
          top_concern.concern,
          top_concern.count,
          top_concerns.value,
          top_desired_insights.value,
          trusted_sources.value,
          top_price_point.monthly_price,
          top_price_point.count
        `,
    );

    return res.json(
      result.rows[0] ?? {
        participants: 0,
        topConcern: null,
        topConcernPercent: 0,
        spentMoneyPercent: 0,

        yesCount: 0,
        maybeCount: 0,
        noCount: 0,
        commercialInterestCount: 0,
        commercialInterestPercent: 0,
        topConcerns: [],
        topDesiredInsights: [],
        trustedSources: [],
      },
    );
  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      error: "Research metrics failed",
    });
  }
});

router.get("/", (_req, res) => {
  res.json({
    success: true,
  });
});

export default router;
