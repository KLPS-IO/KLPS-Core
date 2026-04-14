import { pool }
from "../storage/postgres.client";

import { generateInsight }
from "./insight.service";

export const saveDailySummary = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  /**
   1 — Get today's signals
   */

  const signals = await pool.query(
    `
    SELECT
      question_key,
      response_value,
      domain

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
   2 — Build meaningful summary
   */

  let summary =
    "Today you showed:\n\n";

  responses.forEach((r) => {

    const value =
      r.response_value;

    const domain =
      r.domain;

    if (!value) return;

    /**
     Reflection
     */

    if (domain === "reflection") {

      summary +=
        `• Reflection: ${value}\n`;

    }

    /**
     Emotion
     */

    else if (domain === "emotion") {

      summary +=
        `• Feeling: ${value}\n`;

    }

    /**
     Body
     */

    else if (domain === "body") {

      summary +=
        `• Body signal: ${value}\n`;

    }

    /**
     Cycle
     */

    else if (domain === "cycle") {

      summary +=
        `• Cycle state: ${value}\n`;

    }

    /**
     Environment
     */

    else if (domain === "environment") {

      summary +=
        `• Environment: ${value}\n`;

    }

    /**
     Social
     */

    else if (domain === "social") {

      summary +=
        `• Social: ${value}\n`;

    }

    /**
     Fallback
     */

    else {

      summary +=
        `• ${value}\n`;

    }

  });

  /**
   Safety fallback
   */

  if (
    summary.trim() ===
    "Today you showed:"
  ) {

    summary +=
      "• You showed up today.\n";

  }

  /**
   3 — Generate behaviour insight
   */

  try {

    await generateInsight({
      user_id
    });

  }

  catch (error) {

    console.error(
      "Insight generation failed:",
      error
    );

  }

  /**
   4 — Save summary
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

    ON CONFLICT (user_id, day_number)

    DO UPDATE SET
      summary_text = EXCLUDED.summary_text,
      insight_data = EXCLUDED.insight_data,
      created_at = NOW();
    `,
    [
      user_id,
      day_number,
      summary,
      JSON.stringify({})
    ]
  );

  return summary;

};