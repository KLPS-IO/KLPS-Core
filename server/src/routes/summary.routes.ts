import express from "express";

import { saveDailySummary } from "../services/summary.service";

import {
  getActiveSession,
  completeSession
} from "../services/session.service";

import {
  updateStreak
} from "../services/streak.service";

import {
  detectPatterns
} from "../services/pattern.service";


const router = express.Router();


router.get("/today", async (req, res) => {

  try {

    const userId =
      (req.query.user_id as string) ||
      "11111111-1111-1111-1111-111111111111";


    /**
     * Step 1 — Get active session
     */

    const activeSession =
      await getActiveSession({
        user_id: userId
      });

    if (!activeSession) {

      return res.status(400).json({
        status: "error",
        message: "No active session found"
      });

    }

    const dayNumber =
      activeSession.day_number;


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
     */

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
     * Step 6 — Return summary
     */

    res.json({
      status: "success",
      summary
    });

  } catch (error) {

    console.error(
      "Summary route error:",
      error
    );

    res.status(500).json({
      status: "error",
      message: "Failed to get summary"
    });

  }

});


export default router;