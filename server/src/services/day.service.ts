import { pool } from "../storage/postgres.client";

export async function getCurrentDay(userId: string): Promise<number> {

  const result = await pool.query(
    `
    SELECT
      (CURRENT_DATE - start_date) + 1 AS current_day
    FROM lema.streaks
    WHERE user_id = $1
    `,
    [userId]
  );

  if (result.rows.length === 0) {
    throw new Error("User streak not found");
  }

  return result.rows[0].current_day;

}