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

    // Get correct day automatically
    const currentDay =
      await getCurrentDay(userId);

    // Fetch today's questions
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

      LEFT JOIN lema.signals s
        ON s.question_key = q.question_key
        AND s.user_id = $2
        AND s.day_number = $1

      LEFT JOIN (
          SELECT DISTINCT
            question_key,
            option_value,
            option_label,
            sort_order,
            id
          FROM lema.response_options
          WHERE active = true
      ) ro
        ON ro.question_key = q.question_key

      WHERE
        q.protocol_version = 'EARLY_V1'
        AND q.day_number = $1
        AND q.active = true
        AND s.id IS NULL

      GROUP BY
        q.id

      ORDER BY
        q.id
      `,
      [currentDay, userId]
    );

    res.json({
      status: "success",
      day: currentDay,
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