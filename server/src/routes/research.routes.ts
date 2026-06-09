import { Router } from "express";
import multer from "multer";
import { uploadToR2 } from "../services/r2.service";
import { submitResearchResponse } from "../services/research.service";
import { pool } from "../storage/postgres.client";
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

    const filesByField = (req.files ?? {}) as Partial<
      Record<VoiceField, Express.Multer.File[]>
    >;

    const files = [
      ...(filesByField.voice_0 ?? []),
      ...(filesByField.voice_1 ?? []),
      ...(filesByField.voice_2 ?? []),
      ...(filesByField.voice_3 ?? []),
    ];

    if (files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No files received",
      });
    }

    const uploadedFiles = await Promise.all(
      (files ?? []).map(async (file) => {
        const objectKey = `test/${Date.now()}-${file.originalname}`;

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

    const submission = await submitResearchResponse({
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
      wouldUse: asString(payload.wouldUse) || undefined,
      wouldPay: asString(payload.wouldPay) || undefined,
      monthlyPrice: asString(payload.monthlyPrice) || undefined,
      desiredInsights: asStringArray(payload.desiredInsights),
      otherInsight: asString(payload.otherInsight) || undefined,
      trustedSource: asStringArray(
        payload.trustedSource ?? payload.trusted_source,
      ),
      recordings: uploadedFiles.map((uploadedFile) =>
        toRecordingInput(payload, uploadedFile),
      ),
    });

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
        concern_values AS (
          SELECT
            concern
          FROM survey_responses
          CROSS JOIN LATERAL jsonb_each(
            CASE
              WHEN jsonb_typeof(concerns) = 'object'
              THEN concerns
              ELSE '{}'::jsonb
            END
          ) AS concern_groups(area, values_json)
          CROSS JOIN LATERAL jsonb_array_elements_text(
            CASE
              WHEN jsonb_typeof(values_json) = 'array'
              THEN values_json
              ELSE '[]'::jsonb
            END
          ) AS concern
        ),
        top_concern AS (
          SELECT
            concern,
            COUNT(*)::int AS count
          FROM concern_values
          GROUP BY concern
          ORDER BY count DESC, concern ASC
          LIMIT 1
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
                  trusted_source,
                  'count',
                  count
                )
                ORDER BY count DESC, trusted_source ASC
              ),
              '[]'::jsonb
            ) AS value
          FROM (
            SELECT
              trusted_source,
              COUNT(*)::int AS count
            FROM survey_responses
            WHERE
              trusted_source IS NOT NULL
              AND trusted_source <> ''
            GROUP BY trusted_source
            ORDER BY count DESC, trusted_source ASC
            LIMIT 5
          ) ranked
        )
        SELECT
          totals.participants,
          top_concern.concern AS "topConcern",
          CASE
            WHEN totals.participants = 0
            THEN 0
            ELSE ROUND(
              top_concern.count * 100.0 /
              totals.participants,
              2
            )
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
              ) * 100.0 / totals.participants,
              2
            )
          END AS "spentMoneyPercent",
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
                ) IN ('yes', 'true', 'y')
              ) * 100.0 / totals.participants,
              2
            )
          END AS "wouldPayPercent",
          top_desired_insights.value AS "topDesiredInsights",
          trusted_sources.value AS "trustedSources"
        FROM totals
        CROSS JOIN top_desired_insights
        CROSS JOIN trusted_sources
        LEFT JOIN top_concern ON true
        LEFT JOIN survey_responses ON true
        GROUP BY
          totals.participants,
          top_concern.concern,
          top_concern.count,
          top_desired_insights.value,
          trusted_sources.value
        `,
    );

    return res.json(
      result.rows[0] ?? {
        participants: 0,
        topConcern: null,
        topConcernPercent: 0,
        spentMoneyPercent: 0,
        wouldPayPercent: 0,
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
