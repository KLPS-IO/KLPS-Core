import { pool } from "../storage/postgres.client";

const getDayFromStreak = async (
  userId: string
) => {

  return pool.query(
    `
    SELECT
      (CURRENT_DATE - start_date) + 1 AS current_day
    FROM lema.streaks
    WHERE user_id = $1
    `,
    [userId]
  );

};

export async function getCurrentDay(userId: string): Promise<number> {

  let result =
    await getDayFromStreak(userId);

  if (result.rows.length === 0) {

    await pool.query(
      `
      INSERT INTO lema.streaks (
        user_id,
        current_streak,
        longest_streak,
        last_active,
        start_date
      )
      VALUES ($1, 1, 1, CURRENT_DATE, CURRENT_DATE)
      ON CONFLICT (user_id) DO NOTHING
      `,
      [userId]
    );

    result =
      await getDayFromStreak(userId);
  }

  return Number(result.rows[0].current_day);

}

export async function getSafeCurrentDay({
  userId,
  protocolVersion
}: {
  userId: string;
  protocolVersion: string;
}): Promise<number> {

  const currentDay =
    await getCurrentDay(userId);

  const maxDayResult = await pool.query(
    `
    SELECT MAX(day_number) AS max_day
    FROM lema.questions
    WHERE protocol_version = $1
    `,
    [protocolVersion]
  );

  const maxDay =
    Number(maxDayResult.rows[0]?.max_day ?? 1);

  if (currentDay > maxDay) {
    return maxDay;
  }

  return currentDay;

}
