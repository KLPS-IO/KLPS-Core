// server/src/routes/founder.ts

import { Router } from "express";
import db from "../config/db";
import { pool }
from "../storage/postgres.client";
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
        data: result.rows.map(row => ({
            total_users: Number(row.total_users),
            active_users: Number(row.active_users),
            completed_checkins: Number(row.completed_checkins),
            avg_completion_rate: Number(row.avg_completion_rate)
        }))
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
        data: result.rows.map(row => ({
            label: row.label,
            users: Number(row.users)
        }))
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
            completed
          FROM lema.v_checkin_completion
          ORDER BY day_number
        `);

      res.json({
        data: result.rows.map(row => ({
          label: row.label,
          completed: Number(row.completed)
        }))
      });

    } catch (error) {

      console.error(
        "checkin-completion error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch check-in completion"
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
        data: result.rows.map(row => ({
          label: row.label,
          users: Number(row.users)
        }))
      });

    } catch (error) {

      console.error(
        "user-growth error:",
        error
      );

      res.status(500).json({
        error:
          "Failed to fetch user growth"
      });

    }

  }
);

/* -------------------------------------------------- */
/* PATTERN FREQUENCY — INVESTOR SAFE */
/* -------------------------------------------------- */

router.get(
  "/pattern-frequency",
  async (req, res) => {

    try {

      const result =
        await pool.query(`

        SELECT
          pattern_key AS pattern,
          SUM(frequency)::int AS count

        FROM lema.daily_patterns

        GROUP BY pattern_key

        ORDER BY count DESC

        LIMIT 10

        `);

      return res.json(
        result.rows
      );

    }

    catch (error) {

      console.error(
        "Pattern frequency error:",
        error
      );

      return res.status(500).json({

        status: "error",

        message:
          "Failed to fetch pattern frequency"

      });

    }

  }
);

export default router;