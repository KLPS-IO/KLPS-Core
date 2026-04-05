import { pool } from "../storage/postgres.client";
import { generateInsight } from "./insight.service";

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

      user_id,
      day_number,
      summary_text

    )

    VALUES ($1,$2,$3)

    ON CONFLICT (
      user_id,
      day_number
    )

    DO UPDATE SET

      summary_text =
        EXCLUDED.summary_text
    `,
    [
      user_id,
      day_number,
      summary
    ]
  );

  return summary;

};