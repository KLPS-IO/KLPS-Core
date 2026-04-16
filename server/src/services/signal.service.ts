import { pool } from "../storage/postgres.client";

export const saveSignal = async ({
  user_id,
  day_number,
  question_key,
  response_value,
  domain,
  time_of_day
}: {
  user_id: string;
  day_number: number;
  question_key: string;
  response_value: string;
  domain: string;
  time_of_day?: string;
}) => {

  // 1 — Save signal
  await pool.query(
    `
    INSERT INTO lema.signals (
      user_id,
      day_number,
      question_key,
      response_value,
      domain
    )
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (user_id, day_number, question_key)
    DO UPDATE SET
      response_value = EXCLUDED.response_value
    `,
    [
      user_id,
      day_number,
      question_key,
      response_value,
      domain
    ]
  );

  // 2 — Fetch next unanswered question
  const next = await pool.query(
    `
    SELECT
      q.question_key,
      q.question_text,
      q.domain,
      q.response_type,
      q.allow_multiple,

      COALESCE(
        json_agg(
          json_build_object(
            'value', ro.option_value,
            'label', ro.option_label
          )
          ORDER BY ro.sort_order
        ) FILTER (WHERE ro.id IS NOT NULL),
        '[]'
      ) AS options

    FROM lema.questions q

    LEFT JOIN lema.response_options ro
      ON ro.question_key = q.question_key
      AND ro.active = true

    WHERE
      q.protocol_version = 'EARLY_V1'
      AND q.day_number = $1
      AND q.active = true

      AND NOT EXISTS (
        SELECT 1
        FROM lema.signals s
        WHERE
          s.question_key = q.question_key
          AND s.user_id = $2
          AND s.day_number = $1
      )

    GROUP BY q.id

    ORDER BY q.id;
    `,
    [day_number, user_id]
  );

  return {
    next_question:
      next.rows.length > 0
        ? next.rows[0]
        : null
  };

};
