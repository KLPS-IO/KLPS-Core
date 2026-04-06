import { pool } from "../storage/postgres.client";

/**
 * Store insight into memory
 */

export const saveInsight = async ({
  user_id,
  insight_text
}: {
  user_id: string;
  insight_text: string;
}) => {

  if (!insight_text) return;

  await pool.query(
    `
    INSERT INTO lema.insight_catalog (

      user_id,
      insight_text,
      source,
      domain

    )

    VALUES (
      $1,
      $2,
      'pattern_engine',
      'behaviour'
    )

    ON CONFLICT (
      user_id,
      insight_text
    )

    DO UPDATE SET

      confidence_score =
        lema.insight_catalog.confidence_score + 1,

      last_detected =
        CURRENT_DATE
    `,
    [
      user_id,
      insight_text
    ]
  );

};