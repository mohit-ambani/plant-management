import express from "express";
import cors from "cors";
import path from "path";
import db from "./db";
import batchRoutes from "./routes/batch";

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

app.use("/api/batches", batchRoutes);

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get("/api/settings", async (_req, res) => {
  const rows = await db.query("SELECT key, value FROM settings");
  const settings: Record<string, string> = {};
  for (const row of rows) settings[row.key] = row.value;
  res.json(settings);
});

app.put("/api/settings", async (req, res) => {
  const { key, value } = req.body;
  if (!key) { res.status(400).json({ error: "Key is required" }); return; }
  await db.execute(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    [key, value || "", value || ""]
  );
  res.json({ message: "Setting saved", key, value });
});

app.get("/api/logs", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const logs = await db.query("SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset]);
  const countResult = await db.queryOne("SELECT COUNT(*) as total FROM api_logs");
  const total = countResult?.total || 0;
  res.json({ logs, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// Serve frontend in production
const frontendPath = path.join(__dirname, "..", "public");
app.use(express.static(frontendPath));
app.get("*", (_req, res) => {
  res.sendFile(path.join(frontendPath, "index.html"));
});

async function start() {
  await db.init();
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
