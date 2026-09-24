import express from "express";
import cors from "cors";
import { migrateAndSeed } from "./db.js";
import { router } from "./routes.js";
import { startCronJobs } from "./cron.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/healthz", (_req, res) => res.status(200).send("ok"));
app.use("/api", router);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || "Internal error" });
});

const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await migrateAndSeed();
    startCronJobs();
    app.listen(PORT, () => console.log(`family-backend listening on :${PORT}`));
  } catch (e) {
    console.error("Startup failed:", e);
    process.exit(1);
  }
})();
