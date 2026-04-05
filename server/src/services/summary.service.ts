import { pool } from "../storage/postgres.client";

export const saveDailySummary = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  // 1 — Get all answers
  const signals = await pool.query(
    `
    SELECT question_key, response_value
    FROM lema.signals
    WHERE user_id = $1
    AND day_number = $2
    `,
    [user_id, day_number]
  );

  const responses = signals.rows;

  let summary = "Today you showed:\n\n";

  const insightData: any = {};

  responses.forEach((r) => {

    if (r.question_key.includes("progress")) {

      summary +=
        `• Progress: ${r.response_value}\n`;

      insightData.progress =
        r.response_value;

    }

    if (r.question_key.includes("reflection")) {

      summary +=
        `• Reflection: ${r.response_value}\n`;

      insightData.reflection =
        r.response_value;

    }

    if (r.question_key.includes("block")) {

      summary +=
        `• Challenge: ${r.response_value}\n`;

      insightData.challenge =
        r.response_value;

    }

    if (r.question_key.includes("support")) {

      summary +=
        `• Support: ${r.response_value}\n`;

      insightData.support =
        r.response_value;

    }

    if (r.question_key.includes("future")) {

      summary +=
        `• Next Step: ${r.response_value}\n`;

      insightData.next_step =
        r.response_value;

    }

  });


  // 2 — Save summary + insight JSON

  await pool.query(
    `
    INSERT INTO lema.daily_summaries (
      user_id,
      day_number,
      summary_text,
      insight_data
    )
    VALUES ($1,$2,$3,$4)

    ON CONFLICT (user_id, day_number)

    DO UPDATE SET
      summary_text = EXCLUDED.summary_text,
      insight_data = EXCLUDED.insight_data
    `,
    [
      user_id,
      day_number,
      summary,
      insightData
    ]
  );

  return summary;

};