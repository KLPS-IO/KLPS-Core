import { pool } from "../storage/postgres.client";

/**
 * Generate behaviour insight
 * based on recent + frequent patterns
 */

export const generateInsight = async ({
  user_id
}: {
  user_id: string;
}) => {

  /**
   * Get strongest recent patterns
   */

  const patterns = await pool.query(
    `
    SELECT
      pattern_key,
      frequency,
      last_detected

    FROM lema.daily_patterns

    WHERE
      user_id = $1

      AND last_detected >=
        CURRENT_DATE - INTERVAL '7 days'

    ORDER BY
      frequency DESC,
      last_detected DESC

    LIMIT 5
    `,
    [user_id]
  );

  if (patterns.rows.length === 0) {

    return "You're beginning to build awareness through reflection.";

  }

  const insights: string[] = [];

  patterns.rows.forEach(row => {

    const key =
      row.pattern_key;

    const freq =
      row.frequency;

    /**
     * Only meaningful repetition
     */

    if (freq >= 3) {

      insights.push(
        `You've mentioned feeling ${key} several times recently.`
      );

    }

  });

  if (insights.length === 0) {

    return "You're continuing to explore your daily patterns.";

  }

  return insights.join(" ");

};