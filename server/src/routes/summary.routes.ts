import express from "express";
import { pool } from "../storage/postgres.client";
import { saveDailySummary } from "../services/summary.service";

const router = express.Router();

router.get("/today", async (req, res) => {
  try {
    const userId =
      (req.query.user_id as string) ||
      "11111111-1111-1111-1111-111111111111";

    const dayNumber =
      Number(req.query.day_number) || 1;

    // Generate + save summary
    const summary = await saveDailySummary({
      user_id: userId,
      day_number: dayNumber
    });

    res.json({
      status: "success",
      summary
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      status: "error",
      message: "Failed to get summary"
    });
  }
});

export default router;