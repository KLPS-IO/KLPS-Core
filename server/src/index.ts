import express from "express";
import cors from "cors";

import signalRouter from "./api/signal.route";
import questionRouter from "./api/question.route";
import summaryRoutes from "./routes/summary.routes";
import sessionRoutes from "./routes/session.routes";

const app = express();

/**
 * Middleware
 */

app.use(express.json());

app.use(
  cors({
    origin: [
      "http://localhost:8080",
      "http://localhost:8081",
      "https://klps-lema.vercel.app"
    ],
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true
  })
);

/**
 * Routes
 */

app.use("/api", signalRouter);
app.use("/api/questions", questionRouter);
app.use("/api/summary", summaryRoutes);
app.use("/api/session", sessionRoutes);

/**
 * Start Server
 */

const PORT =
  process.env.PORT || 5001;

app.listen(PORT, () => {

  console.log(
    `LEMA running on port ${PORT}`
  );

});