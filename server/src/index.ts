import express from "express";
import cors from "cors";

import signalRouter from "./api/signal.route";
import questionRouter from "./api/question.route";
import summaryRoutes from "./routes/summary.routes";
import sessionRoutes from "./routes/session.routes";

const app = express();

/**
 * Allowed origins
 */

const allowedOrigins = [

  "http://localhost:8080",
  "http://localhost:8081",

  "https://klps.co.uk",
  "https://www.klps.co.uk",

  "https://klps-lema.vercel.app"

];

/**
 * CORS middleware
 */

app.use(
  cors({
    origin: (origin, callback) => {

      // allow server-to-server or curl
      if (!origin) {

        return callback(null, true);

      }

      if (
        allowedOrigins.includes(origin)
      ) {

        callback(null, true);

      } else {

        console.warn(
          "Blocked by CORS:",
          origin
        );

        callback(null, false);

      }

    },

    methods: [
      "GET",
      "POST",
      "OPTIONS"
    ],

    credentials: true

  })
);

/**
 * Debug Logging Middleware
 */

app.use((req, res, next) => {

  console.log(
    `${req.method} ${req.path}`
  );

  next();

});

/**
 * JSON Middleware
 */

app.use(express.json());

/**
 * Routes
 */

app.use("/api", signalRouter);
app.use("/api/questions", questionRouter);
app.use("/api/summary", summaryRoutes);
app.use("/api/session", sessionRoutes);

/**
 * Health Check
 */

app.get("/", (req, res) => {

  res.json({
    status: "LEMA API running"
  });

});

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