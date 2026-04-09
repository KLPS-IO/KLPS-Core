import express from "express";
import { pool } from "../storage/postgres.client";
import { getSafeCurrentDay } from "../services/day.service";
import { startSessionIfNeeded }
from "../services/session.service";
import { ensureUserProfile }
from "../services/user-profile.service";

const router = express.Router();

router.get("/today", async (req, res) => {

  try {

    /**
     * PHASE 2 — Require user_id
     */

    const userId =
      req.query.user_id as string;

    if (!userId) {

      return res.status(400).json({

        status: "error",

        message:
          "user_id is required"

      });

    }

    /**
     * STEP 1 — Get day
     */

    await ensureUserProfile({
      userId,
      cohortVersion: "EARLY_V1"
    });

    /**
     * STEP 2 — Block repeat check-ins for the current calendar day.
     * A completed check-in is defined as any signal created today.
     */

    const completedTodayCheck = await pool.query(
      `
      SELECT COUNT(*) AS count
      FROM lema.signals
      WHERE user_id = $1
      AND DATE(created_at) = CURRENT_DATE;
      `,
      [userId]
    );

    const completedToday =
      Number(completedTodayCheck.rows[0].count) > 0;

    if (completedToday) {

      console.log(
        "User already completed today:",
        userId
      );

      return res.json({
        day: null,
        questions: [],
        completedToday: true
      });

    }

    /**
     * STEP 3 — Get day
     */

    const safeDay =
      await getSafeCurrentDay({
        userId,
        protocolVersion: "EARLY_V1"
      });

    /**
     * STEP 4 — Start session
     */

    await startSessionIfNeeded({

      user_id: userId,

      protocol_version: "EARLY_V1",

      day_number: safeDay

    });

    /**
     * STEP 5 — Get latest cycle state
     */

    const cycleCheck = await pool.query(
      `
      SELECT response_value
      FROM lema.signals
      WHERE
        user_id = $1
        AND question_key = 'cycle_stage'
      ORDER BY day_number DESC
      LIMIT 1
      `,
      [userId]
    );

    let skipCycle = false;

    if (cycleCheck.rows.length > 0) {

      const latest =
        cycleCheck.rows[0].response_value;

      if (

        latest === "Perimenopause" ||

        latest === "Menopause" ||

        latest === "Prefer not to say"

      ) {

        skipCycle = true;

      }

    }

    /**
     * STEP 6 — Fetch questions
     */

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
          )
          FILTER (WHERE ro.id IS NOT NULL),
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

        AND (

          $1 = 1

          OR q.question_key != 'cycle_stage'

          OR $3 = false

        )

      GROUP BY q.id

      ORDER BY q.sort_order;
      `,
      [
        safeDay,
        userId,
        skipCycle
      ]
    );

    res.json({

      status: "success",

      day: safeDay,

      questions: result.rows

    });

  }

  catch (error) {

    console.error(error);

    res.status(500).json({

      status: "error",

      message:
        "Failed to fetch today's questions"

    });

  }

});

export default router;
