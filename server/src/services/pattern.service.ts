import { pool } from "../storage/postgres.client";

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
    SELECT
      question_key,
      response_value
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
   * Keywords to detect
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

    // behavioural
    "tired",
    "stressed",
    "overwhelmed",
    "calm",
    "productive",
    "blocked",
    "motivated"

  ];

  /**
   * Store unique matches only
   */

  const queries: Promise<any>[] = [];

  signals.rows.forEach(row => {

    const text =
      row.response_value
        .toLowerCase();

    const detected =
      new Set<string>();

    keywords.forEach(keyword => {

      if (text.includes(keyword)) {

        detected.add(keyword);

      }

    });

    /**
     * Insert detected patterns
     */

    detected.forEach(keyword => {

      queries.push(

        pool.query(
  `
  INSERT INTO lema.daily_patterns (

    user_id,
    pattern_type,
    pattern_key,
    day_number,
    question_key

  )

  VALUES (
    $1,
    'keyword',
    $2,
    $3,
    $4
  )

  ON CONFLICT ON CONSTRAINT unique_pattern

  DO UPDATE SET

    frequency =
      lema.daily_patterns.frequency + 1,

    last_detected =
      CURRENT_DATE
  `,
  [
    user_id,
    keyword,
    day_number,
    row.question_key
  ]
)

      );

    });

  });

  await Promise.all(queries);

  console.log(
    "Pattern detection complete"
  );

};