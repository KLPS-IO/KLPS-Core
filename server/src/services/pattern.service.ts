import { pool } from "../storage/postgres.client";

function normaliseResponseValue(
  value: unknown
): string {

  if (typeof value === "string") {

    return value;

  }

  if (Array.isArray(value)) {

    return value
      .map(normaliseResponseValue)
      .filter(Boolean)
      .join(" ");

  }

  if (
    value &&
    typeof value === "object"
  ) {

    return Object.values(value)
      .map(normaliseResponseValue)
      .filter(Boolean)
      .join(" ");

  }

  if (
    value === null ||
    value === undefined
  ) {

    return "";

  }

  return String(value);

}

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

    "great",
    "good",
    "okay",
    "struggling",

    "excellent",
    "fair",
    "poor",

    "high",
    "medium",
    "low",

    "intense",
    "light",
    "not yet",

    "tired",
    "stressed",
    "overwhelmed",
    "calm",
    "productive",
    "blocked",
    "motivated"

  ];

  /**
   * GLOBAL deduplication
   */

  const insertedPatterns =
    new Set<string>();

  for (const row of signals.rows) {

    const text =
      normaliseResponseValue(
        row.response_value
      ).toLowerCase();

    if (!text) continue;

    for (const keyword of keywords) {

      if (!text.includes(keyword)) continue;

      /**
       * Build unique key
       */

      const uniqueKey =
        `${user_id}-${keyword}-${day_number}-${row.question_key}`;

      if (
        insertedPatterns.has(uniqueKey)
      ) {

        continue;

      }

      insertedPatterns.add(uniqueKey);

      /**
       * Safe insert
       */

      await pool.query(
  `
  INSERT INTO lema.daily_patterns (

    user_id,
    pattern_type,
    pattern_key,
    day_number,
    question_key,
    frequency,
    last_detected

  )

  VALUES (
    $1,
    'keyword',
    $2,
    $3,
    $4,
    1,
    CURRENT_DATE
  )

  ON CONFLICT ON CONSTRAINT unique_daily_pattern

  DO UPDATE SET

    frequency =
      COALESCE(
        lema.daily_patterns.frequency,
        0
      ) + 1,

    last_detected =
      CURRENT_DATE
  `,
  [
    user_id,
    keyword,
    day_number,
    row.question_key
  ]
);

    }

  }

  console.log(
    "Pattern detection complete"
  );

};
