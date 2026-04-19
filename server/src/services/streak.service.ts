import { pool } from "../storage/postgres.client";
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

  const existing = await pool.query(
    `
    SELECT
      current_streak,
      longest_streak,
      freeze_tokens,
      last_active,
      (
        DATE(NOW() AT TIME ZONE $2)
        - last_active
      )::int AS diff_days
    FROM lema.streaks
    WHERE user_id = $1
    LIMIT 1
    `,
    [
      user_id,
      timezone
    ]
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
        1,
        1,
        DATE(NOW() AT TIME ZONE $2),
        DATE(NOW() AT TIME ZONE $2)
      )
      `,
      [
        user_id,
        timezone
      ]
    );

    return;

  }

  const streak = existing.rows[0];

  const diffDays =
    Number(
      streak.diff_days ?? 0
    );

  let newStreak =
    streak.current_streak;

  /**
   * Same day — do nothing
   */

  if (diffDays === 0) {
    return;
  }

  /**
   * Next consecutive day
   */

  if (diffDays === 1) {

    newStreak =
      streak.current_streak + 1;

  }

  /**
   * Missed day
   */

  if (diffDays > 1) {

    if (streak.freeze_tokens > 0) {

      newStreak =
        streak.current_streak;

      await pool.query(
        `
        UPDATE lema.streaks
        SET
          freeze_tokens = freeze_tokens - 1
        WHERE user_id = $1
        `,
        [user_id]
      );

    } else {

      newStreak = 1;

    }

  }

  const newLongest =
    Math.max(
      newStreak,
      streak.longest_streak
    );

  await pool.query(
    `
    UPDATE lema.streaks
    SET
      current_streak = $1,
      longest_streak = $2,
      last_active =
        DATE(NOW() AT TIME ZONE $3),
      updated_at = NOW()
    WHERE user_id = $4
    `,
    [
      newStreak,
      newLongest,
      timezone,
      user_id
    ]
  );

};
