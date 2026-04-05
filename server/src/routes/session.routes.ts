import express from "express";

import { startSessionIfNeeded } from "../services/session.service";
import { getCurrentDay } from "../services/day.service";

const router = express.Router();

router.post("/start", async (req, res) => {

  try {

    const { user_id } = req.body;

    // Get correct day dynamically

    const dayNumber =
      await getCurrentDay(user_id);

    // Start session safely

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