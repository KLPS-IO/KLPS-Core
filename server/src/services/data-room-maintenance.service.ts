import { pool } from "../storage/postgres.client";

export const cleanupExpiredDataRoomAuth = async () => {
  const otpResult =
    await pool.query(
      `
      DELETE FROM data_room.login_otps
      WHERE
        expires_at < now() - interval '1 day'
        OR consumed_at < now() - interval '1 day'
      `
    );

  const sessionResult =
    await pool.query(
      `
      UPDATE data_room.sessions
      SET revoked_at = COALESCE(revoked_at, now())
      WHERE
        expires_at < now()
        AND revoked_at IS NULL
      `
    );

  return {
    deleted_otps: otpResult.rowCount ?? 0,
    revoked_sessions: sessionResult.rowCount ?? 0
  };
};
