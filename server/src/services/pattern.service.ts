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
   * Get today's signals
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

    console.log(
      "No signals found for pattern detection"
    );

    return;

  }

  /**
   * Expanded keyword detection
   */

  const keywords = [

    // mood
    "great",
    "good",
    "okay",
    "struggling",

    // sleep
    "excellent",
    "fair",
    "poor",

    // energy
    "high",
    "medium",
    "low",

    // exercise
    "intense",
    "light",
    "not yet",

    // behavioural keywords
    "tired",
    "stressed",
    "overwhelmed",
    "calm",
    "productive",
    "blocked",
    "motivated"

  ];

  /**
   * Detect unique matches
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
   * Store patterns in parallel
   */

  const queries = [];

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

  await Promise.all(queries);

  console.log(
    "Patterns detected:",
    Array.from(detected)
  );

};