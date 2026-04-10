import { pool } from "../storage/postgres.client";

const APP_TIMEZONE =
  "Europe/London";

type LatestSummaryRow = {
  day_number: number;
  diff_days: number;
};

async function getLatestCompletedSummary(
  userId: string
): Promise<LatestSummaryRow | null> {

  const result = await pool.query(
    `
    SELECT
      day_number,
      (
        DATE(NOW() AT TIME ZONE $2)
        - DATE(created_at AT TIME ZONE $2)
      ) AS diff_days
    FROM lema.daily_summaries
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [userId, APP_TIMEZONE]
  );

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0] as LatestSummaryRow;

}

export async function getCurrentDay(
  userId: string
): Promise<number> {

  const latestSummary =
    await getLatestCompletedSummary(userId);

  if (!latestSummary) {
    return 1;
  }

  const lastDay =
    Number(latestSummary.day_number);

  const diffDays =
    Number(latestSummary.diff_days);

  if (diffDays <= 0) {
    return lastDay;
  }

  return lastDay + 1;

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
