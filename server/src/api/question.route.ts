import express from "express";
import { pool } from "../storage/postgres.client";

import { getSafeCurrentDay }
from "../services/day.service";

import { startSessionIfNeeded }
from "../services/session.service";

import { ensureUserProfile }
from "../services/user-profile.service";

const router = express.Router();

const APP_TIMEZONE =
  "Europe/London";

router.get("/today", async (req, res) => {

  try {

    /**
     * Require user_id
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
     * STEP 1 — Ensure profile exists
     */

    await ensureUserProfile({

      userId,

      cohortVersion:
        "EARLY_V1"

    });

    /**
     * STEP 2 — Get last completed day
     * (Needed for streak display)
     */

    const lastCompletedResult =
      await pool.query(
        `
        SELECT MAX(day_number) AS last_day
        FROM lema.daily_sessions
        WHERE
          user_id = $1
          AND completion_status = 'completed'
        `,
        [userId]
      );

    const lastCompletedDay =
      Number(
        lastCompletedResult.rows[0]?.last_day ?? 1
      );

    /**
     * STEP 3 — REAL completed-today check
     */

    const completedTodayCheck =
      await pool.query(
        `
        SELECT 1
        FROM lema.daily_sessions
        WHERE
          user_id = $1
          AND completion_status = 'completed'
          AND completed_at AT TIME ZONE $2
              >= date_trunc(
                'day',
                NOW() AT TIME ZONE $2
              )
        LIMIT 1
        `,
        [
          userId,
          APP_TIMEZONE
        ]
      );

    const completedToday =
      completedTodayCheck.rows.length > 0;

    /**
     * If completed today,
     * return NO questions but DO return streak day
     */

    if (completedToday) {

      return res.json({

        status: "success",

        day: null,

        questions: [],

        completedToday: true,

        lastCompletedDay: lastCompletedDay

      });

    }

    /**
     * STEP 4 — Get safe day
     */

    const safeDay =
      await getSafeCurrentDay({

        userId,

        protocolVersion:
          "EARLY_V1"

      });

    /**
     * STEP 5 — Ensure session exists
     */

    await startSessionIfNeeded({

      user_id:
        userId,

      protocol_version:
        "EARLY_V1",

      day_number:
        safeDay

    });

    /**
     * STEP 6 — Detect cycle skip state
     */

    const cycleCheck =
      await pool.query(
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
        cycleCheck.rows[0]
          .response_value;

      if (

        latest === "Perimenopause" ||

        latest === "Menopause" ||

        latest === "Prefer not to say"

      ) {

        skipCycle = true;

      }

    }

    /**
     * STEP 7 — Fetch questions
     */

    const result =
      await pool.query(
        `
        SELECT
          q.question_key,
          q.question_text,
          q.domain,
          q.response_type,
          q.allow_multiple,

          COALESCE(
            json_agg(
              json_build_object(
                'value',
                ro.option_value,

                'label',
                ro.option_label
              )
              ORDER BY ro.sort_order
            )
            FILTER (
              WHERE ro.id
              IS NOT NULL
            ),
            '[]'
          ) AS options

        FROM lema.questions q

        LEFT JOIN
          lema.response_options ro
        ON
          ro.question_key =
            q.question_key
          AND ro.active = true

        WHERE

          q.protocol_version =
            'EARLY_V1'

          AND q.day_number =
            $1

          AND q.active = true

          AND (

            $1 = 1

            OR q.question_key
               != 'cycle_stage'

            OR $2 = false

          )

        GROUP BY
          q.id

        ORDER BY
          q.sort_order;
        `,
        [
          safeDay,
          skipCycle
        ]
      );

    /**
     * STEP 8 — Return result
     */

    res.json({

      status: "success",

      day: safeDay,

      questions: result.rows,

      completedToday: false,

      lastCompletedDay: lastCompletedDay

    });

  }

  catch (error) {

    console.error(
      "Question route error:",
      error
    );

    res.status(500).json({

      status: "error",

      message:
        "Failed to fetch today's questions"

    });

  }

});

export default router;
