import { pool } from "../storage/postgres.client";

/**
 * Update user streak after session completion
 */
export const updateStreak = async ({
  user_id
}: {
  user_id: string;
}) => {

  const today = new Date();
  today.setHours(0,0,0,0);

  const existing = await pool.query(
    `
    SELECT *
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
      VALUES ($1,1,1,CURRENT_DATE,CURRENT_DATE)
      `,
      [user_id]
    );

    return;

  }

  const streak = existing.rows[0];

  const lastActive =
    new Date(streak.last_active);

  lastActive.setHours(0,0,0,0);

  const diffDays =
    Math.floor(
      (today.getTime() - lastActive.getTime())
      / (1000 * 60 * 60 * 24)
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
      last_active = CURRENT_DATE,
      updated_at = NOW()
    WHERE user_id = $3
    `,
    [
      newStreak,
      newLongest,
      user_id
    ]
  );

};