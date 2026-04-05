import { pool } from "../storage/postgres.client";

type SessionInput = {
  user_id: string;
  protocol_version: string;
  day_number: number;
};

/**
 * Start session safely (idempotent)
 * Uses ON CONFLICT to prevent duplicate sessions
 */
export const startSessionIfNeeded = async ({
  user_id,
  protocol_version,
  day_number
}: SessionInput) => {

  const created = await pool.query(
    `
    INSERT INTO lema.daily_sessions (
      user_id,
      protocol_version,
      day_number
    )
    VALUES ($1,$2,$3)

    ON CONFLICT (user_id, day_number)
    DO UPDATE
      SET started_at = lema.daily_sessions.started_at

    RETURNING *
    `,
    [
      user_id,
      protocol_version,
      day_number
    ]
  );

  return created.rows[0];

};



/**
 * Get active session (if exists)
 */
export const getActiveSession = async ({
  user_id
}: {
  user_id: string;
}) => {

  const result = await pool.query(
    `
    SELECT *
    FROM lema.daily_sessions
    WHERE
      user_id = $1
      AND completion_status = 'in_progress'
    ORDER BY started_at DESC
    LIMIT 1
    `,
    [user_id]
  );

  return result.rows[0] || null;

};



/**
 * Mark session as completed
 */
export const completeSession = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  const result = await pool.query(
    `
    UPDATE lema.daily_sessions
    SET
      completed_at = NOW(),
      completion_status = 'completed'
    WHERE
      user_id = $1
      AND day_number = $2
      AND completion_status = 'in_progress'
    RETURNING *
    `,
    [user_id, day_number]
  );

  return result.rows[0] || null;

};



/**
 * Get session status
 */
export const getSessionStatus = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  const result = await pool.query(
    `
    SELECT
      completion_status,
      started_at,
      completed_at,
      session_date
    FROM lema.daily_sessions
    WHERE
      user_id = $1
      AND day_number = $2
    LIMIT 1
    `,
    [user_id, day_number]
  );

  return result.rows[0] || null;

};



/**
 * Detect missed days safely
 * Midnight-safe calculation
 */
export const detectMissedDays = async ({
  user_id
}: {
  user_id: string;
}) => {

  const result = await pool.query(
    `
    SELECT session_date
    FROM lema.daily_sessions
    WHERE user_id = $1
    ORDER BY session_date DESC
    LIMIT 1
    `,
    [user_id]
  );

  if (result.rows.length === 0) {
    return 0;
  }

  const lastDate =
    new Date(result.rows[0].session_date);

  const today =
    new Date();

  // Normalize both dates to midnight
  today.setHours(0,0,0,0);
  lastDate.setHours(0,0,0,0);

  const diffTime =
    today.getTime() - lastDate.getTime();

  const diffDays =
    Math.floor(diffTime / (1000 * 60 * 60 * 24));

  return diffDays;

};