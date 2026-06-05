type Env = {
  DB?: D1Database;
  SURVEY_DB?: D1Database;
  SURVEY_RECORDINGS?: R2Bucket;
  KLPS_SURVEY_RECORDINGS?: R2Bucket;
  SURVEY_RESPONSES?: KVNamespace;
};

type SurveyPayload = {
  bodyAreas?: unknown;
  concerns?: unknown;
  frequency?: unknown;
  currentSolutions?: unknown;
  fullName?: unknown;
  email?: unknown;
  consent?: unknown;
  voiceIncluded?: unknown;
};

const json = (
  body: unknown,
  init?: ResponseInit
) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });

const asString = (value: unknown) =>
  typeof value === "string"
    ? value.trim()
    : "";

const requireArray = (
  value: unknown,
  fallback: unknown[] = []
) => Array.isArray(value)
  ? value
  : fallback;

const isValidEmail = (value: string) =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

const ensureD1Tables = async (
  db: D1Database
) => {
  await db
    .prepare(
      `
      CREATE TABLE IF NOT EXISTS survey_responses (
        id TEXT PRIMARY KEY,
        body_areas TEXT NOT NULL,
        concerns TEXT NOT NULL,
        frequency TEXT,
        current_solutions TEXT NOT NULL,
        voice_recording_path TEXT,
        first_name TEXT NOT NULL,
        email TEXT NOT NULL,
        consent INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
      `
    )
    .run();
};

export const onRequestPost: PagesFunction<Env> =
  async ({ request, env }) => {
    try {
      const formData =
        await request.formData();

      const rawPayload =
        formData.get("payload");

      if (
        typeof rawPayload !== "string"
      ) {
        return json(
          { error: "Missing survey payload." },
          { status: 400 }
        );
      }

      const payload =
        JSON.parse(rawPayload) as SurveyPayload;

      const fullName =
        asString(payload.fullName);
      const email =
        asString(payload.email).toLowerCase();
      const consent =
        payload.consent === true;
      const bodyAreas =
        requireArray(payload.bodyAreas);
      const currentSolutions =
        requireArray(payload.currentSolutions);
      const hasContact =
        Boolean(fullName || email);

      if (
        bodyAreas.length === 0
      ) {
        return json(
          { error: "Survey response is incomplete." },
          { status: 400 }
        );
      }

      if (
        hasContact &&
        (!email || !isValidEmail(email) || !consent)
      ) {
        return json(
          { error: "Please provide a valid email and consent to stay involved." },
          { status: 400 }
        );
      }

      const id =
        crypto.randomUUID();
      const createdAt =
        new Date().toISOString();

      const voice =
        formData.get("voice");
      let voiceRecordingPath:
        string | null = null;

      const bucket =
        env.SURVEY_RECORDINGS ??
        env.KLPS_SURVEY_RECORDINGS;

      if (
        voice instanceof File &&
        voice.size > 0 &&
        bucket
      ) {
        voiceRecordingPath =
          `survey-recordings/${id}.webm`;
        await bucket.put(
          voiceRecordingPath,
          voice.stream(),
          {
            httpMetadata: {
              contentType:
                voice.type ||
                "audio/webm"
            }
          }
        );
      }

      const record = {
        id,
        bodyAreas,
        concerns:
          payload.concerns &&
          typeof payload.concerns ===
            "object"
            ? payload.concerns
            : {},
        frequency:
          asString(payload.frequency),
        currentSolutions,
        voiceRecordingPath,
        fullName,
        email,
        consent,
        createdAt
      };

      const db =
        env.SURVEY_DB ?? env.DB;

      if (db) {
        await ensureD1Tables(db);
        await db
          .prepare(
            `
            INSERT INTO survey_responses (
              id,
              body_areas,
              concerns,
              frequency,
              current_solutions,
              voice_recording_path,
              first_name,
              email,
              consent,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
          )
          .bind(
            id,
            JSON.stringify(record.bodyAreas),
            JSON.stringify(record.concerns),
            record.frequency,
            JSON.stringify(record.currentSolutions),
            voiceRecordingPath,
            fullName,
            email,
            consent ? 1 : 0,
            createdAt
          )
          .run();
      }
      else if (env.SURVEY_RESPONSES) {
        await env.SURVEY_RESPONSES.put(
          id,
          JSON.stringify(record)
        );
      }
      else {
        return json(
          {
            error:
              "Survey storage is not configured. Bind D1 as SURVEY_DB or KV as SURVEY_RESPONSES."
          },
          { status: 500 }
        );
      }

      return json({
        status: "success",
        id
      });
    }
    catch (error) {
      console.error(error);
      return json(
        { error: "Could not save survey response." },
        { status: 500 }
      );
    }
  };
