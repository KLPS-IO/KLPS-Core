import { pool } from "../storage/postgres.client";
import {
  DEFAULT_TIMEZONE
} from "./timezone.service";

type LatestSessionRow = {
  day_number: number;
  diff_days: number;
};

async function getLatestCompletedSession(
  userId: string,
  timezone: string
): Promise<LatestSessionRow | null> {

  const result = await pool.query(
    `
    SELECT
      day_number,

      (
        DATE(NOW() AT TIME ZONE $2)
        - DATE(completed_at AT TIME ZONE $2)
      ) AS diff_days

    FROM lema.daily_sessions

    WHERE
      user_id = $1
      AND completion_status = 'completed'

    ORDER BY completed_at DESC

    LIMIT 1
    `,
    [userId, timezone]
  );

  if (result.rows.length === 0) {

    return null;

  }

  return result.rows[0] as LatestSessionRow;

}

export async function getCurrentDay(
  userId: string,
  timezone: string =
    DEFAULT_TIMEZONE
): Promise<number> {

  const latestSession =
    await getLatestCompletedSession(
      userId,
      timezone
    );

  /**
   No completed sessions → Day 1
   */

  if (!latestSession) {

    return 1;

  }

  const lastDay =
    Number(latestSession.day_number);

  const diffDays =
    Number(latestSession.diff_days);

  /**
   Same day → stay
   */

  if (diffDays <= 0) {

    return lastDay;

  }

  /**
   Next day OR missed days
   → Only advance ONE day
   (never skip days)
   */

  return lastDay + 1;

}

export async function getSafeCurrentDay({
  userId,
  protocolVersion,
  timezone = DEFAULT_TIMEZONE
}: {
  userId: string;
  protocolVersion: string;
  timezone?: string;
}): Promise<number> {

  const currentDay =
    await getCurrentDay(
      userId,
      timezone
    );

  const maxDayResult =
    await pool.query(
      `
      SELECT MAX(day_number) AS max_day
      FROM lema.questions
      WHERE protocol_version = $1
      `,
      [protocolVersion]
    );

  const maxDay =
    Number(
      maxDayResult.rows[0]?.max_day ?? 1
    );

  /**
   Prevent overflow past protocol
   */

  if (currentDay > maxDay) {

    return maxDay;

  }

  /**
   Safety floor
   */

  if (currentDay < 1) {

    return 1;

  }

  return currentDay;

}
