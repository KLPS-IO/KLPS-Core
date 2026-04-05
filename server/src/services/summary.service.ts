import { pool } from "../storage/postgres.client";

export const saveDailySummary = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  // 1 — Get all answers for that day
  const signals = await pool.query(
    `
    SELECT question_key, response_value
    FROM lema.signals
    WHERE user_id = $1
    AND day_number = $2
    `,
    [user_id, day_number]
  );

  // 2 — Build simple summary (v1 logic)
  const responses = signals.rows;

 // Build smarter summary

let summary = "Today you showed:\n\n";

responses.forEach((r) => {

  if (r.question_key.includes("progress")) {
    summary += `• Progress: ${r.response_value}\n`;
  }

  if (r.question_key.includes("reflection")) {
    summary += `• Reflection: ${r.response_value}\n`;
  }

  if (r.question_key.includes("block")) {
    summary += `• Challenge: ${r.response_value}\n`;
  }

  if (r.question_key.includes("support")) {
    summary += `• Support: ${r.response_value}\n`;
  }

  if (r.question_key.includes("future")) {
    summary += `• Next Step: ${r.response_value}\n`;
  }

});

  // 3 — Save summary
  await pool.query(
    `
    INSERT INTO lema.daily_summaries (
      user_id,
      day_number,
      summary_text
    )
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, day_number)
    DO UPDATE SET summary_text = EXCLUDED.summary_text
    `,
    [user_id, day_number, summary]
  );

  return summary;
};