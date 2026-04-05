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

  let summary = "Today you showed:\n\n";

  if (responses.length === 0) {
    summary += "You started your reflection journey.";
  } else {

    // Basic interpretation (we will upgrade this later)
    summary += "• You reflected on your day\n";
    summary += "• You identified what felt challenging\n";
    summary += "• You recognised what helped you\n";
    summary += "• You showed awareness of your behaviour\n";

  }

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