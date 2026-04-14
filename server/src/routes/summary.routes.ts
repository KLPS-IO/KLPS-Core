import express from "express";

import {
  completeSession
} from "../services/session.service";

import { pool }
from "../storage/postgres.client";

import {
  updateStreak
} from "../services/streak.service";

import {
  detectPatterns
} from "../services/pattern.service";

import {
  generateInsight
} from "../services/insight.service";

const router = express.Router();

/* -------------------------------------------------- */
/* TODAY ROUTE — ORIGINAL BEHAVIOUR */
/* -------------------------------------------------- */

router.get("/today", async (req, res) => {

  try {

    const userId =
      req.query.user_id as string;

    if (!userId) {

      return res.status(400).json({
        status: "error",
        message: "user_id is required"
      });

    }

    /**
     * STEP 1 — Get latest session
     */

    const sessionResult =
      await pool.query(
        `
        SELECT *
        FROM lema.daily_sessions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [userId]
      );

    if (sessionResult.rows.length === 0) {

      return res.json({
        status: "success",
        summary_text: "",
        completedToday: false
      });

    }

    const latestSession =
      sessionResult.rows[0];

    const dayNumber: number =
      latestSession.day_number;

    /**
     * STEP 2 — Check existing summary
     */

    const summaryResult =
      await pool.query(
        `
        SELECT summary_text
        FROM lema.daily_summaries
        WHERE user_id = $1
        AND day_number = $2
        LIMIT 1
        `,
        [userId, dayNumber]
      );

    let summary: string = "";

    if (summaryResult.rows.length > 0) {

      summary =
        summaryResult.rows[0].summary_text;

    }

    /**
     * STEP 3 — Complete session
     */

    if (
      latestSession.completion_status !== "completed"
    ) {

      await completeSession({
        user_id: userId,
        day_number: dayNumber
      });

    }

    /**
     * STEP 4 — Generate summary if missing
     */

    if (!summary) {

      console.log(
        "Generating reflection summary..."
      );

      const signalsResult =
        await pool.query(
          `
          SELECT
            question_key,
            response_value
          FROM lema.signals
          WHERE
            user_id = $1
            AND day_number = $2
          ORDER BY created_at ASC
          `,
          [userId, dayNumber]
        );

      const responses =
        signalsResult.rows.filter(
          r =>
            typeof r.response_value === "string"
        );

      const reflectionParts: string[] = [];

      /**
       * Find meaningful text response
       */

      const textResponse =
        responses.find(r =>
          r.response_value &&
          r.response_value.length > 15
        );

      if (textResponse) {

        reflectionParts.push(
          `You shared that "${textResponse.response_value}".`
        );

      }

      /**
       * Find likely emotion
       */

      const emotionResponse =
        responses.find(r =>
          r.response_value &&
          r.response_value.length > 0 &&
          r.response_value.length < 25
        );

      if (emotionResponse) {

        reflectionParts.push(
          `You noticed feeling ${emotionResponse.response_value}.`
        );

      }

      /**
       * Add encouragement
       */

      if (reflectionParts.length > 0) {

        reflectionParts.push(
          "Taking time to notice these experiences builds awareness and consistency."
        );

      }

      /**
       * Fallback
       */

      if (reflectionParts.length === 0) {

        reflectionParts.push(
          "You showed up and reflected today — that matters."
        );

      }

      summary =
        reflectionParts.join(" ");

      /**
       * IMPORTANT:
       * No DELETE — ON CONFLICT handles safely
       */

      
      await pool.query(
      `
      INSERT INTO lema.daily_summaries (
        user_id,
        day_number,
        calendar_date,
        summary_text
      )

      VALUES (
        $1,
        $2,
        CURRENT_DATE,
        $3
      )

      ON CONFLICT (user_id, day_number)

      DO UPDATE SET
        summary_text = EXCLUDED.summary_text,
        calendar_date = CURRENT_DATE;
      `,
      [
        userId,
        dayNumber,
        summary
      ]
      );

    }

    /**
     * STEP 5 — Update streak
     */

    await updateStreak({
      user_id: userId
    });

    /**
     * STEP 6 — Detect patterns
     */

    await detectPatterns({
      user_id: userId,
      day_number: dayNumber
    });

    /**
     * STEP 7 — Generate insight
     */

    try {

      await generateInsight({
        user_id: userId
      });

    }

    catch (error) {

      console.error(
        "Insight generation failed:",
        error
      );

    }

    /**
     * STEP 8 — Return summary
     */

    return res.json({

      status: "success",

      summary_text: summary,

      completedToday: true

    });

  }

  catch (error) {

    console.error(
      "Summary route error:",
      error
    );

    return res.status(500).json({

      status: "error",

      message: "Failed"

    });

  }

});


/* -------------------------------------------------- */
/* WORD CLOUD ROUTE — NEW SAFE ADDITION */
/* -------------------------------------------------- */

router.get("/word-cloud", async (req, res) => {

  try {

    const stopWords =
      new Set<string>([

        "the","and","is","to","a","i",
        "me","my","you","it","in",
        "on","for","with","that",
        "this","was","are","today",
        "very","feel","felt"

      ]);

    type SignalRow = {
      response_value: string | null;
    };

    function processWords(
      rows: SignalRow[]
    ) {

      const counts:
        Record<string, number> = {};

      rows.forEach(row => {

        if (!row.response_value) return;

        const words: string[] =
          row.response_value
            .toLowerCase()
            .replace(/[^\w\s]/g, "")
            .split(/\s+/);

        words.forEach((word: string) => {

          if (
            !word ||
            stopWords.has(word) ||
            word.length < 3
          ) return;

          counts[word] =
            (counts[word] || 0) + 1;

        });

      });

      return Object.entries(counts)

        .map(([text, value]) => ({

          text,
          value

        }))

        .sort((a, b) =>
          b.value - a.value
        )

        .slice(0, 50);

    }

    /**
     * HISTORICAL
     */

    const historicalResult =
      await pool.query<SignalRow>(`

        SELECT response_value
        FROM lema.signals
        WHERE response_value IS NOT NULL

      `);

    /**
     * LAST 7 DAYS
     */

    const last7Result =
      await pool.query<SignalRow>(`

        SELECT response_value
        FROM lema.signals
        WHERE response_value IS NOT NULL
        AND created_at >= NOW() - INTERVAL '7 days'

      `);

    const historical =
      processWords(
        historicalResult.rows
      );

    const last7Days =
      processWords(
        last7Result.rows
      );

    return res.json({

      last7Days,
      historical

    });

  }

  catch (error) {

    console.error(
      "Word cloud error:",
      error
    );

    return res.status(500).json({

      status: "error",

      message:
        "Failed to generate word cloud"

    });

  }

});


export default router;