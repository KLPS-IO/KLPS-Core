import express from "express";
import { saveSignal } from "../services/signal.service";

const router = express.Router();

const getTimeOfDay = () => {

  const hour = new Date().getHours();

  if (hour < 12) return "morning";
  if (hour < 17) return "afternoon";
  if (hour < 21) return "evening";

  return "night";
};

router.post("/signal", async (req, res) => {

  const timeOfDay = getTimeOfDay();

  try {

    const {
      user_id,
      day_number,
      question_key,
      response_value,
      domain
    } = req.body;

    const result = await saveSignal({
      user_id,
      day_number,
      question_key,
      response_value,
      domain
    });

    res.status(200).json({
      status: "saved",
      data: result
    });

  } catch (error) {

    console.error("Signal error:", error);

    const message =
      error instanceof Error ? error.message : String(error);

      res.status(500).json({
        status: "error",
        message
      });

  }

});

export default router;