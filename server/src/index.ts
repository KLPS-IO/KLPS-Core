import express from "express";
import cors from "cors";
import signalRouter from "./api/signal.route";
import questionRouter from "./api/question.route";

const app = express();

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

// Routes
app.use("/api", signalRouter);
app.use("/api/questions", questionRouter);
app.use(express.json());

app.use("/api", signalRouter);
app.use("/api/questions", questionRouter);

// IMPORTANT: dynamic port for Railway
const PORT = process.env.PORT || 5001;

app.listen(PORT, () => {
  console.log(`LEMA running on port ${PORT}`);
});