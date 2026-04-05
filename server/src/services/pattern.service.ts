import { pool } from "../storage/postgres.client";

/**
 * Detect simple behaviour patterns
 * based on today's responses
 */

export const detectPatterns = async ({
  user_id,
  day_number
}: {
  user_id: string;
  day_number: number;
}) => {

  /**
   * Step 1 — Get today's signals
   */

  const signals = await pool.query(
    `
    SELECT response_value
    FROM lema.signals
    WHERE
      user_id = $1
      AND day_number = $2
    `,
    [user_id, day_number]
  );

  if (signals.rows.length === 0) {
    return;
  }


  /**
   * Step 2 — Keyword library
   * (Phase 1 detection)
   */

  const keywords = [
    "tired",
    "stressed",
    "overwhelmed",
    "calm",
    "productive",
    "blocked",
    "motivated"
  ];


  /**
   * Step 3 — Detect unique matches
   */

  const detected =
    new Set<string>();


  signals.rows.forEach(row => {

    const text =
      row.response_value
        .toLowerCase();

    keywords.forEach(keyword => {

      if (text.includes(keyword)) {

        detected.add(keyword);

      }

    });

  });


  /**
   * Step 4 — Store detected patterns
   * (Parallel inserts for performance)
   */

  const queries: Promise<any>[] = [];

  for (const key of detected) {

    queries.push(

      pool.query(
        `
        INSERT INTO lema.daily_patterns (
          user_id,
          pattern_type,
          pattern_key
        )

        VALUES ($1,'keyword',$2)

        ON CONFLICT (
          user_id,
          pattern_type,
          pattern_key
        )

        DO UPDATE SET

          frequency =
            lema.daily_patterns.frequency + 1,

          last_detected =
            CURRENT_DATE
        `,
        [user_id, key]
      )

    );

  }


  /**
   * Step 5 — Execute all inserts
   */

  if (queries.length > 0) {

    await Promise.all(queries);

  }

};