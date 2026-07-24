import express from "express";
import cors from "cors";

import signalRouter from "./api/signal.route";
import questionRouter from "./api/question.route";
import summaryRoutes from "./routes/summary.routes";
import sessionRoutes from "./routes/session.routes";
import founderRoutes from "./routes/founder";
import dataRoomRoutes from "./routes/data-room.routes";
import financeRoutes from "./routes/finance.routes";
import waitlistRoutes from "./routes/waitlist.routes";
import growthRoutes from "./growth/growth.routes";
import {
  getSessionUser,
  hasAcceptedCurrentNda,
  requireAdmin,
  requireDataRoomAuth
} from "./services/data-room.service";
import { pool } from "./storage/postgres.client";
import researchRoutes
  from "./routes/research.routes";
const app = express();

app.set("trust proxy", 1);
app.disable("x-powered-by");

/**
 * Allowed origins
 */

const allowedOrigins = [

  "http://localhost:3000",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:8081",
  "http://127.0.0.1:3000",
  "http://127.0.0.1:5000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:8080",
  "http://127.0.0.1:8081",

  "https://klps.co.uk",
  "https://www.klps.co.uk",

  "https://klps-core.vercel.app"

];

if (process.env.FRONTEND_ORIGIN) {
  allowedOrigins.push(
    ...process.env.FRONTEND_ORIGIN
      .split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

if (process.env.FRONTEND_ORIGINS) {
  allowedOrigins.push(
    ...process.env.FRONTEND_ORIGINS
      .split(",")
      .map(origin => origin.trim())
      .filter(Boolean)
  );
}

const isAllowedOrigin = (origin: string) =>
  allowedOrigins.includes(origin) ||
  /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

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

      if (isAllowedOrigin(origin)) {

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
      "PATCH",
      "DELETE",
      "OPTIONS"
    ],

    credentials: true

  })
);

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()"
  );

  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains"
    );
  }

  next();
});

app.use((req, res, next) => {
  if (!["POST", "PATCH", "DELETE"].includes(req.method)) {
    return next();
  }

  const origin = req.get("origin");

  if (origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({
      status: "error",
      code: "origin_not_allowed",
      message: "Request origin is not allowed"
    });
  }

  next();
});

if (process.env.NODE_ENV === "production") {
  app.use((req, res, next) => {
    if (req.secure || req.header("x-forwarded-proto") === "https") {
      return next();
    }

    res.status(426).json({
      status: "error",
      message: "HTTPS is required"
    });
  });
}

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

app.use(express.json({ limit: "1mb" }));

/**
 * Routes
 */

app.use("/api", signalRouter);
app.use("/api/questions", questionRouter);
app.use("/api/summary", summaryRoutes);
app.use("/api/session", sessionRoutes);
app.use("/api/waitlist", waitlistRoutes);
app.use(
  "/api/founder",
  requireDataRoomAuth,
  requireAdmin,
  founderRoutes
);
app.use("/api/data-room", dataRoomRoutes);
app.use("/api/finance", financeRoutes);
app.use("/api/growth", growthRoutes);
app.use("/api/research", researchRoutes);

app.get("/api/auth/me", async (req, res) => {
  const session =
    await getSessionUser(req);

  if (!session) {
    return res.json({
      status: "success",
      authenticated: false,
      user: null
    });
  }

  const nda =
    await hasAcceptedCurrentNda(session.user.id);

  res.json({
    status: "success",
    authenticated: true,
    user: {
      id: session.user.id,
      email: session.user.email,
      role: session.user.role,
      access_tier: session.user.accessTier,
      is_admin:
        session.user.role === "founder_admin"
    },
    nda: {
      current_version:
        nda.nda?.version ?? null,
      accepted: nda.accepted,
      accepted_at: nda.acceptedAt ?? null
    }
  });
});

/**
 * Health Check
 */

app.get("/", (req, res) => {

  res.json({
    status: "LEMA API running"
  });

});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "LEMA API"
  });
});

app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");

    res.json({
      status: "ready",
      database: "ok"
    });
  } catch (error) {
    console.error("readiness check failed:", error);

    res.status(503).json({
      status: "not_ready",
      database: "error"
    });
  }
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
