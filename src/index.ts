import express from "express";
import signalRouter from "./api/signal.route";
import questionRouter from "./api/question.route";

const app = express();

app.use(express.json());

app.use("/api", signalRouter);

app.use("/api/questions", questionRouter);

app.listen(5001, () => {
  console.log("LEMA running on port 5001");
});