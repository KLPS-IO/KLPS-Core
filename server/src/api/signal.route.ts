import express from "express";

import { saveSignal } from "../services/signal.service";

import { pool } from "../storage/postgres.client";

import {
  startSessionIfNeeded
} from "../services/session.service";

import {
  getCurrentDay
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

    /**
     * Get correct day
     */

    const dayNumber =
      await getCurrentDay(user_id);


    /**
     * Ensure session exists
     */

    await startSessionIfNeeded({

      user_id,

      protocol_version: "EARLY_V1",

      day_number: dayNumber

    });


    const timeOfDay =
      getTimeOfDay();


    /**
     * Save signal
     */

    const result =
      await saveSignal({

        user_id,

        day_number: dayNumber,

        question_key,

        response_value,

        domain: timeOfDay

      });


    res.status(200).json({

      status: "saved",

      data: result

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