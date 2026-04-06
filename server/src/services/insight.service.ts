import { pool } from "../storage/postgres.client";

/**
 * Generate behaviour insight
 */

export const generateInsight = async ({
  user_id
}: {
  user_id: string;
}) => {

  const patterns = await pool.query(
    `
    SELECT
      pattern_key,
      frequency
    FROM lema.daily_patterns
    WHERE user_id = $1
    ORDER BY frequency DESC
    LIMIT 3
    `,
    [user_id]
  );

  if (patterns.rows.length === 0) {

    return
      "You're beginning to build awareness through reflection.";

  }

  const insights: string[] = [];

  patterns.rows.forEach(row => {

    const key =
      row.pattern_key;

    const freq =
      row.frequency;

    /**
     * NEW — Always generate text
     */

    if (freq >= 3) {

      insights.push(
        `You've mentioned feeling ${key} several times recently.`
      );

    } else {

      insights.push(
        `You've reported feeling ${key} today.`
      );

    }

  });

  return insights.join(" ");

};