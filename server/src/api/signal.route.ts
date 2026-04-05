import express from "express";
import { saveSignal } from "../services/signal.service";
import { pool } from "../storage/postgres.client";

const router = express.Router();

const getTimeOfDay = () => {

  const hour = new Date().getHours();

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

    /**
     * Get active session day
     */

    const session = await pool.query(
      `
      SELECT day_number
      FROM lema.daily_sessions
      WHERE user_id = $1
      AND completion_status = 'in_progress'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (session.rows.length === 0) {

      return res.status(400).json({
        status: "error",
        message: "No active session"
      });

    }

    const day_number =
      session.rows[0].day_number;

    const timeOfDay =
      getTimeOfDay();

    /**
     * Save signal
     */

    const result = await saveSignal({

      user_id,

      day_number,

      question_key,

      response_value,

      domain: timeOfDay

    });

    res.status(200).json({

      status: "saved",

      data: result

    });

  } catch (error) {

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