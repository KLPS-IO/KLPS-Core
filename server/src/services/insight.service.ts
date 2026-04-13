import { pool } from "../storage/postgres.client";

const PATTERN_GROUPS: Record<string, string[]> = {

  resilience: [
    "perseverance",
    "overcame",
    "persist",
    "keep going",
    "against the odds",
    "progress",
    "goals"
  ],

  fatigue: [
    "tired",
    "bloated",
    "heavy",
    "exhausted",
    "low energy"
  ],

  stress: [
    "anxiety",
    "overwhelmed",
    "pressure",
    "mistake",
    "stress"
  ],

  growth: [
    "improve",
    "progress",
    "achievement",
    "learning"
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
   * Require at least 2 signals
   */

  if (count < 2) {

    return "";

  }

  if (pattern === "resilience") {

    return "I've noticed a pattern of perseverance in how you've been approaching your days. You keep moving forward even when things feel challenging.";

  }

  if (pattern === "fatigue") {

    return "I've noticed your body signals suggest periods of tiredness or heaviness. Listening to those signals can help you move with more balance.";

  }

  if (pattern === "stress") {

    return "I've noticed moments of pressure appearing in your reflections. The way you continue despite that shows strength.";

  }

  if (pattern === "growth") {

    return "I've noticed steady growth in how you're reflecting and moving forward. You're building momentum.";

  }

  return "";

}

export async function generateInsight({
  user_id
}: {
  user_id: string;
}) {

  /**
   * Step 1 — Fetch all responses
   */

  const result =
    await pool.query(
      `
      SELECT response_value
      FROM lema.signals
      WHERE user_id = $1
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
   * Step 2 — Detect patterns
   */

  const patternCounts =
    detectPatterns(responses);

  /**
   * Step 3 — Build message
   */

  const patternMessage =
    buildPatternMessage(
      patternCounts
    );

  if (!patternMessage) {

    return;

  }

  /**
   * Step 4 — Prevent duplicates
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
   * Step 5 — Save insight
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