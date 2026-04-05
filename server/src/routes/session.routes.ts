import express from "express";

import { startSessionIfNeeded } from "../services/session.service";
import { getCurrentDay } from "../services/day.service";

const router = express.Router();

router.post("/start", async (req, res) => {

  try {

    const { user_id } = req.body;

    if (!user_id) {

      return res.status(400).json({
        status: "error",
        message: "user_id required"
      });

    }

    /**
     * Get correct day
     */

    const dayNumber =
      await getCurrentDay(user_id);

    /**
     * Start session
     */

    const session =
      await startSessionIfNeeded({

        user_id,

        protocol_version: "EARLY_V1",

        day_number: dayNumber

      });

    res.json({

      status: "started",

      day: dayNumber,

      session

    });

  }

  catch (error) {

    console.error(error);

    res.status(500).json({

      status: "error",

      message: "Failed to start session"

    });

  }

});

export default router;