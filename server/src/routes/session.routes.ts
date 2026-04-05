import express from "express";
import { startSessionIfNeeded } from "../services/session.service";

const router = express.Router();

router.post("/start", async (req, res) => {

  try {

    const { user_id } = req.body;

    const session =
      await startSessionIfNeeded({

        user_id,

        protocol_version: "EARLY_V1",

        day_number: 1

      });

    res.json({

      status: "started",

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