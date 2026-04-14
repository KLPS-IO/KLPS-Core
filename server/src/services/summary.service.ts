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

    ORDER BY
      domain,
      question_key
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

  let addedLines = 0;

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
        `• You reflected on: ${value}\n`;

      addedLines++;

    }

    /**
     Emotion
     */

    else if (domain === "emotion") {

      summary +=
        `• You felt: ${value}\n`;

      addedLines++;

    }

    /**
     Body
     */

    else if (domain === "body") {

      summary +=
        `• Your body felt: ${value}\n`;

      addedLines++;

    }

    /**
     Cycle
     */

    else if (domain === "cycle") {

      summary +=
        `• Cycle state noted: ${value}\n`;

      addedLines++;

    }

    /**
     Environment
     */

    else if (domain === "environment") {

      summary +=
        `• Your environment included: ${value}\n`;

      addedLines++;

    }

    /**
     Social
     */

    else if (domain === "social") {

      summary +=
        `• Social connection: ${value}\n`;

      addedLines++;

    }

    /**
     Fallback
     */

    else {

      summary +=
        `• ${value}\n`;

      addedLines++;

    }

  });

  /**
   Safety fallback
   */

  if (addedLines === 0) {

    summary +=
      "• You showed up today.\n";

  }

  /**
   Add closing reinforcement
   */

  summary +=
    "\nYou're building consistency — one day at a time.";

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