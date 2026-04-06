import express from "express";
import { pool } from "../storage/postgres.client";
import { getCurrentDay } from "../services/day.service";
import {
  startSessionIfNeeded
} from "../services/session.service";

const router = express.Router();

router.get("/today", async (req, res) => {

  try {

    const userId =
      (req.query.user_id as string) ||
      "11111111-1111-1111-1111-111111111111";

    /**
     * STEP 1 — Get current day safely
     */

    let currentDay = 1;

    try {

      const day =
        await getCurrentDay(userId);

      if (day && day > 0) {

        currentDay = day;

      }

    } catch (err) {

      console.error(
        "getCurrentDay failed — defaulting to Day 1"
      );

      currentDay = 1;

    }

    /**
     * STEP 2 — Ensure session exists
     */

    await startSessionIfNeeded({
      user_id: userId,
      protocol_version: "EARLY_V1",
      day_number: currentDay
    });

    /**
     * STEP 3 — Find max available day
     */

    const maxDayResult =
      await pool.query(
        `
        SELECT MAX(day_number) AS max_day
        FROM lema.questions
        WHERE protocol_version = 'EARLY_V1'
        `
      );

    const maxDay =
      maxDayResult.rows[0]?.max_day || 1;

    /**
     * STEP 4 — Safe day boundary
     */

    const safeDay =
      currentDay > maxDay
        ? maxDay
        : currentDay;

    /**
     * STEP 5 — Fetch questions
     */

    const result =
      await pool.query(
        `
        SELECT
          q.question_key,
          q.question_text,
          q.domain,
          q.response_type,

          COALESCE(
            json_agg(
              json_build_object(
                'value', ro.option_value,
                'label', ro.option_label
              )
              ORDER BY ro.sort_order
            ) FILTER (WHERE ro.id IS NOT NULL),
            '[]'
          ) AS options

        FROM lema.questions q

        LEFT JOIN lema.response_options ro
          ON ro.question_key = q.question_key
          AND ro.active = true

        WHERE
          q.protocol_version = 'EARLY_V1'
          AND q.day_number = $1
          AND q.active = true

          AND NOT EXISTS (
            SELECT 1
            FROM lema.signals s
            WHERE
              s.question_key = q.question_key
              AND s.user_id = $2
              AND s.day_number = $1
          )

        GROUP BY q.id

        ORDER BY q.id;
        `,
        [safeDay, userId]
      );

    /**
     * STEP 6 — Return questions
     */

    res.json({
      status: "success",
      day: safeDay,
      questions: result.rows
    });

  }

  catch (error) {

    console.error(
      "questions/today error:",
      error
    );

    res.status(500).json({
      status: "error",
      message: "Failed to fetch today's questions"
    });

  }

});

export default router;