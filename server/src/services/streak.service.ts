import { pool } from "../storage/postgres.client";
import { logger } from "../logging/logger";
import {
  DEFAULT_TIMEZONE
} from "./timezone.service";

/**
 * Update user streak after session completion
 */
export const updateStreak = async ({
  user_id,
  timezone = DEFAULT_TIMEZONE
}: {
  user_id: string;
  timezone?: string;
}) => {

  const completedResult = await pool.query(
    `
    SELECT COALESCE(MAX(day_number), 1)::int AS computed_streak
    FROM lema.daily_sessions
    WHERE
      user_id = $1
      AND completion_status = 'completed'
    `,
    [user_id]
  );

  const computedStreak =
    Number(
      completedResult.rows[0]
        ?.computed_streak ?? 1
    );

  const existing = await pool.query(
    `
    SELECT
      current_streak,
      longest_streak,
      last_active
    FROM lema.streaks
    WHERE user_id = $1
    LIMIT 1
    `,
    [user_id]
  );

  /**
   * First-time streak creation
   */

  if (existing.rows.length === 0) {

    await pool.query(
      `
      INSERT INTO lema.streaks (
        user_id,
        current_streak,
        longest_streak,
        last_active,
        start_date
      )
      VALUES (
        $1,
        $2,
        $2,
        DATE(NOW() AT TIME ZONE $3),
        DATE(NOW() AT TIME ZONE $3)
      )
      `,
      [
        user_id,
        computedStreak,
        timezone
      ]
    );

    return;

  }

  const streak = existing.rows[0];

  const existingStreak =
    Number(
      streak.current_streak ?? 0
    );

  const nextStreak =
    Math.max(
      existingStreak,
      computedStreak
    );

  if (computedStreak < existingStreak) {
    logger.warn(
      `Streak downgrade prevented for user ${user_id}: existing=${existingStreak}, computed=${computedStreak}`
    );
  }

  if (
    Math.abs(nextStreak - existingStreak) > 1
  ) {
    logger.warn(
      `Streak changed by more than 1 for user ${user_id}: previous=${existingStreak}, next=${nextStreak}, computed=${computedStreak}`
    );
  }

  await pool.query(
    `
    UPDATE lema.streaks
    SET
      current_streak =
        GREATEST(current_streak, $1),
      longest_streak =
        GREATEST(longest_streak, current_streak, $1),
      last_active =
        DATE(NOW() AT TIME ZONE $2),
      updated_at = NOW()
    WHERE user_id = $3
    `,
    [
      computedStreak,
      timezone,
      user_id
    ]
  );

};
