import { pool } from "../storage/postgres.client";

const PATTERN_GROUPS: Record<string, string[]> = {

  resilience: [
    "keep going",
    "persist",
    "continued",
    "pushed",
    "managed",
    "progress"
  ],

  fatigue: [
    "tired",
    "heavy",
    "exhausted",
    "low energy",
    "rested",
    "fatigue"
  ],

  stress: [
    "overwhelmed",
    "pressure",
    "stress",
    "anxious",
    "tense"
  ],

  growth: [
    "learning",
    "improve",
    "better",
    "progress",
    "aware"
  ]

};

function normaliseText(text: string): string {

  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, "");

}

function detectPatterns(responses: string[]) {

  const counts: Record<string, number> = {};

  responses.forEach(response => {

    const text =
      normaliseText(response);

    Object.entries(PATTERN_GROUPS)
      .forEach(([pattern, keywords]) => {

        keywords.forEach(keyword => {

          if (text.includes(keyword)) {

            counts[pattern] =
              (counts[pattern] || 0) + 1;

          }

        });

      });

  });

  return counts;

}

function buildPatternMessage(
  counts: Record<string, number>
): string {

  const sorted =
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1]);

  if (sorted.length === 0) {

    return "";

  }

  const [pattern, count] =
    sorted[0];

  /**
   Require minimum signal strength
   */

  if (count < 3) {

    return "";

  }

  if (pattern === "resilience") {

    return "You've been showing perseverance across recent days. Even when things feel difficult, you keep moving forward.";

  }

  if (pattern === "fatigue") {

    return "Your recent body signals suggest periods of tiredness. Listening to those signals may help you maintain balance.";

  }

  if (pattern === "stress") {

    return "Pressure or tension has appeared recently. Noticing this is the first step toward managing it.";

  }

  if (pattern === "growth") {

    return "You're showing signs of steady growth. Your reflections suggest increasing awareness.";

  }

  return "";

}

export async function generateInsight({
  user_id
}: {
  user_id: string;
}) {

  /**
   Step 1 — Fetch RECENT responses
   */

  const result =
    await pool.query(
      `
      SELECT response_value

      FROM lema.signals

      WHERE
        user_id = $1

        AND day_number >= (
          SELECT MAX(day_number) - 6
          FROM lema.signals
          WHERE user_id = $1
        )
      `,
      [user_id]
    );

  const responses =
    result.rows.map(
      r => r.response_value
    );

  if (responses.length === 0) {

    return;

  }

  /**
   Step 2 — Detect patterns
   */

  const patternCounts =
    detectPatterns(responses);

  /**
   Step 3 — Build message
   */

  const patternMessage =
    buildPatternMessage(
      patternCounts
    );

  if (!patternMessage) {

    return;

  }

  /**
   Step 4 — Prevent duplicates
   */

  const existing =
    await pool.query(
      `
      SELECT 1
      FROM lema.insights
      WHERE user_id = $1
      AND insight_text = $2
      LIMIT 1
      `,
      [
        user_id,
        patternMessage
      ]
    );

  if (existing.rows.length > 0) {

    return;

  }

  /**
   Step 5 — Save insight
   */

  await pool.query(
    `
    INSERT INTO lema.insights (
      user_id,
      insight_text
    )
    VALUES ($1, $2)
    `,
    [
      user_id,
      patternMessage
    ]
  );

}