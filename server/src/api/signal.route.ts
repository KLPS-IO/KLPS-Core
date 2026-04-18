import express from "express";

import { saveSignal } from "../services/signal.service";

import { pool } from "../storage/postgres.client";
import { updateStreak } from "../services/streak.service";

import {
  startSessionIfNeeded
} from "../services/session.service";

import {
  getSafeCurrentDay
} from "../services/day.service";

const router = express.Router();


const getTimeOfDay = () => {

  const hour =
    new Date().getHours();

  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";

  return "night";

};


router.post("/signal", async (req, res) => {

  try {

    const {
      user_id,
      question_key,
      response_value
    } = req.body;

    if (!user_id) {

      return res.status(400).json({
        status: "error",
        message: "user_id missing"
      });

    }

    if (!question_key || response_value === undefined) {

      return res.status(400).json({
        status: "error",
        message:
          "question_key and response_value are required"
      });

    }

    /**
     * STEP 1 — Get correct day
     */

    const dayNumber =
      await getSafeCurrentDay({
        userId: user_id,
        protocolVersion: "EARLY_V1"
      });


    /**
     * STEP 2 — Ensure session exists
     */

    await startSessionIfNeeded({

      user_id,

      protocol_version: "EARLY_V1",

      day_number: dayNumber

    });


    const timeOfDay =
      getTimeOfDay();


    /**
     * STEP 3 — Save signal
     */

    const result =
      await saveSignal({

        user_id,

        day_number: dayNumber,

        question_key,

        response_value,

        domain: timeOfDay

      });


    /**
     * STEP 4 — Check if day is complete
     */

    const totalQuestionsResult =
      await pool.query(
        `
        SELECT COUNT(*) AS total
        FROM lema.questions
        WHERE
          protocol_version = 'EARLY_V1'
          AND day_number = $1
          AND active = true
        `,
        [dayNumber]
      );

    const totalQuestions =
      Number(
        totalQuestionsResult.rows[0].total
      );


    const answeredQuestionsResult =
      await pool.query(
        `
        SELECT COUNT(DISTINCT question_key) AS answered
        FROM lema.signals
        WHERE
          user_id = $1
          AND day_number = $2
        `,
        [
          user_id,
          dayNumber
        ]
      );

    const answeredQuestions =
      Number(
        answeredQuestionsResult.rows[0].answered
      );


    /**
     * STEP 5 — Mark session completed
     */

    if (
      answeredQuestions >= totalQuestions
    ) {

      console.log(
        "FINAL QUESTION COMPLETE → marking session completed"
      );

      await pool.query(
        `
        UPDATE lema.daily_sessions
        SET
          completion_status = 'completed',
          completed_at = NOW()
        WHERE
          user_id = $1
          AND day_number = $2
        `,
        [
          user_id,
          dayNumber
        ]
      );

      /**
       * Keep streak in sync immediately so
       * completion screen can show fresh value
       * without requiring a refresh.
       */
      await updateStreak({
        user_id
      });

    }

    const completedMetaResult =
      await pool.query(
        `
        SELECT
          COALESCE(
            MAX(
              CASE
                WHEN completion_status = 'completed'
                THEN day_number
                ELSE NULL
              END
            ),
            1
          )::int AS last_completed_day
        FROM lema.daily_sessions
        WHERE user_id = $1
        `,
        [user_id]
      );

    const streakResult =
      await pool.query(
        `
        SELECT current_streak
        FROM lema.streaks
        WHERE user_id = $1
        LIMIT 1
        `,
        [user_id]
      );

    const lastCompletedDay =
      Number(
        completedMetaResult.rows[0]
          ?.last_completed_day ?? 1
      );

    const currentStreak =
      Number(
        streakResult.rows[0]
          ?.current_streak ?? 0
      );

    const isDayComplete =
      answeredQuestions >= totalQuestions;


    res.status(200).json({

      status: "saved",

      data: {
        ...result,
        isDayComplete,
        lastCompletedDay,
        currentStreak
      }

    });

  }

  catch (error) {

    console.error(
      "Signal error:",
      error
    );

    const message =
      error instanceof Error
        ? error.message
        : String(error);

    res.status(500).json({

      status: "error",

      message

    });

  }

});

export default router;
