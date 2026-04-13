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
       * Prevent duplicate summaries
       */

      await pool.query(
        `
        DELETE FROM lema.daily_summaries
        WHERE user_id = $1
        AND day_number = $2
        `,
        [
          userId,
          dayNumber
        ]
      );

      /**
       * Save summary
       */

      await pool.query(
        `
        INSERT INTO lema.daily_summaries (
          user_id,
          day_number,
          summary_text
        )
        VALUES ($1, $2, $3)
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
     * STEP 7 — Generate insight (SAFE MODE)
     */

    try {

      await generateInsight({
        user_id: userId
      });

    } catch (error) {

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

    const errorMessage =
      error instanceof Error
        ? error.message
        : String(error);

    console.error(
      "Summary route error:",
      error
    );

    return res.status(500).json({

      status: "error",

      message: errorMessage

    });

  }

});

export default router;