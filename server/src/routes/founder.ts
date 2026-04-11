// server/src/routes/founder.ts

import { Router } from "express";
import { Pool } from "pg";

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const router = Router();

/*
SESSION SUMMARY
*/

router.get(
  "/session-summary",
  async (req, res) => {

    try {

      const result =
        await db.query(`
          SELECT *
          FROM lema.v_founder_session_summary
        `);

      res.json({
        data: result.rows
      });

    } catch (error) {

      console.error(
        "session-summary error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch session summary"
      });

    }

  }
);

/*
STREAK SUMMARY
*/

router.get(
  "/streak-summary",
  async (req, res) => {

    try {

      const result =
        await db.query(`
          SELECT
            'Average' AS label,
            avg_current AS users
          FROM lema.v_streak_summary

          UNION ALL

          SELECT
            'Max' AS label,
            max_streak AS users
          FROM lema.v_streak_summary
        `);

      res.json({
        data: result.rows
      });

    } catch (error) {

      console.error(
        "streak-summary error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch streak summary"
      });

    }

  }
);

/*
CHECK-IN COMPLETION
*/

router.get(
  "/checkin-completion",
  async (req, res) => {

    try {

      const result =
        await db.query(`
          SELECT
            'Day ' || day_number AS label,
            completed,
            completed AS completion_rate
          FROM lema.v_checkin_completion
          ORDER BY day_number
        `);

      res.json({
        data: result.rows
      });

    } catch (error) {

      console.error(
        "completion error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch completion data"
      });

    }

  }
);

/*
USER GROWTH
*/

router.get(
  "/user-growth",
  async (req, res) => {

    try {

      const result =
        await db.query(`
          SELECT
            DATE(created_at)::text AS label,
            COUNT(*) AS users
          FROM lema.daily_sessions
          GROUP BY DATE(created_at)
          ORDER BY DATE(created_at)
        `);

      res.json({
        data: result.rows
      });

    } catch (error) {

      console.error(
        "growth error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch growth data"
      });

    }

  }
);

export default router;