import express from "express";
import { pool } from "../storage/postgres.client";
import { getCurrentDay } from "../services/day.service";

const router = express.Router();

router.get("/today", async (req, res) => {

  try {

    // Temporary test user
    const userId =
      req.query.user_id as string ||
      "11111111-1111-1111-1111-111111111111";

    // Step 1 — Get calculated day
    const currentDay =
      await getCurrentDay(userId);

    // Step 2 — Get maximum available day
    const maxDayResult = await pool.query(
      `
      SELECT MAX(day_number) AS max_day
      FROM lema.questions
      WHERE protocol_version = 'EARLY_V1'
      `
    );

    const maxDay =
      maxDayResult.rows[0].max_day || 1;

    // Step 3 — Create safe day
    const safeDay =
      currentDay > maxDay
        ? maxDay
        : currentDay;

    // Step 4 — Fetch questions using safeDay
    const result = await pool.query(
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

    res.json({
      status: "success",
      day: safeDay,
      questions: result.rows
    });

  } catch (error) {

    console.error(error);

    res.status(500).json({
      status: "error",
      message: "Failed to fetch today's questions"
    });

  }

});

export default router;