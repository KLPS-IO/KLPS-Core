import express from "express";

import { saveDailySummary } from "../services/summary.service";

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
      (req.query.user_id as string) ||
      "11111111-1111-1111-1111-111111111111";


    /**
     * Step 1 — Get latest session
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

      return res.status(400).json({
        status: "error",
        message: "No session found"
      });

    }

    const latestSession =
      sessionResult.rows[0];

    const dayNumber =
      latestSession.day_number;


    /**
     * Step 2 — Generate summary
     */

    const summary =
      await saveDailySummary({
        user_id: userId,
        day_number: dayNumber
      });


    /**
     * Step 3 — Complete session
     * only if not already completed
     */

    if (
      latestSession.completion_status !== "completed"
    ) {

      console.log(
        "Completing session:",
        userId,
        "day:",
        dayNumber
      );

      await completeSession({
        user_id: userId,
        day_number: dayNumber
      });

    }


    /**
     * Step 4 — Update streak
     */

    await updateStreak({
      user_id: userId
    });


    /**
     * Step 5 — Detect behaviour patterns
     */

    await detectPatterns({
      user_id: userId,
      day_number: dayNumber
    });


    /**
     * Step 6 — Generate Insight
     */

    await generateInsight({
      user_id: userId
    });


    /**
     * Step 7 — Return summary
     */

    res.json({
      status: "success",
      summary
    });

  } catch (error) {

  const errorMessage =
    error instanceof Error ? error.message : String(error);

  console.error(
    "Summary route error:",
    error
  );

  res.status(500).json({
    status: "error",
    message: errorMessage || "Failed to get summary"
  });

}

});


export default router;