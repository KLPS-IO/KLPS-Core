import { pool } from "../storage/postgres.client";
import { generateInsight } from "./insight.service";
import { saveInsight }
from "./insight.persistence.service";

export const saveDailySummary = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  /**
   * 1 — Get today's signals
   */

  const signals = await pool.query(
    `
    SELECT
      question_key,
      response_value
    FROM lema.signals
    WHERE
      user_id = $1
      AND day_number = $2
    `,
    [user_id, day_number]
  );

  const responses =
    signals.rows;

  /**
   * 2 — Build summary text
   */

  let summary =
    "Today you showed:\n\n";

  responses.forEach((r) => {

    if (r.question_key.includes("progress")) {

      summary +=
        `• Progress: ${r.response_value}\n`;

    }

    if (r.question_key.includes("reflection")) {

      summary +=
        `• Reflection: ${r.response_value}\n`;

    }

    if (r.question_key.includes("block")) {

      summary +=
        `• Challenge: ${r.response_value}\n`;

    }

    if (r.question_key.includes("support")) {

      summary +=
        `• Support: ${r.response_value}\n`;

    }

    if (r.question_key.includes("future")) {

      summary +=
        `• Next Step: ${r.response_value}\n`;

    }

  });

  /**
   * 3 — Generate behaviour insight
   */

  const insight =
    await generateInsight({
      user_id
    });

  if (insight) {
    await saveInsight({
      user_id,
      insight_text: insight
    });
  }

  /**
   * Add insight to summary
   */

  if (insight) {

    summary +=
      `\n${insight}`;

  }

  /**
   * 4 — Save summary
   */

  await pool.query(
  `
  INSERT INTO lema.daily_summaries (
    id,
    user_id,
    day_number,
    created_at,
    summary_text,
    insight_data
  )

  VALUES (
    gen_random_uuid(),
    $1,
    $2,
    NOW(),
    $3,
    $4
  )

  ON CONFLICT ON CONSTRAINT daily_summaries_user_id_day_number_key

  DO UPDATE SET
    summary_text = EXCLUDED.summary_text,
    insight_data = EXCLUDED.insight_data,
    created_at = NOW();
  `,
  [
    user_id,
    day_number,
    summary,
    JSON.stringify({ insight })
  ]
);

  return summary;

};