import { Router, Request, Response } from "express";
import db from "../db";

const router = Router();

// Create a new batch
router.post("/", async (req: Request, res: Response) => {
  const { startSerial, endSerial, batchCode, skuId, productionDate } = req.body;

  if (!startSerial || !endSerial || !batchCode || !skuId || !productionDate) {
    res.status(400).json({ error: "All fields are required" });
    return;
  }

  // Parse serial numbers: single letter (A-Z) + digits
  const startMatch = startSerial.match(/^([A-Za-z])(\d+)$/);
  const endMatch = endSerial.match(/^([A-Za-z])(\d+)$/);

  if (!startMatch || !endMatch) {
    res.status(400).json({ error: "Invalid serial number format. Use 1 letter (A-Z) + digits (e.g., A1, A100000)" });
    return;
  }

  const prefix = startMatch[1].toUpperCase();
  const endPrefix = endMatch[1].toUpperCase();

  if (prefix !== endPrefix) {
    res.status(400).json({ error: "Start and end serial numbers must have the same prefix" });
    return;
  }

  const startNum = parseInt(startMatch[2], 10);
  const endNum = parseInt(endMatch[2], 10);

  if (endNum <= startNum) {
    res.status(400).json({ error: "End serial number must be greater than start serial number" });
    return;
  }

  const quantity = endNum - startNum;
  const numWidth = Math.max(startMatch[2].length, endMatch[2].length);

  // Check for overlapping serial numbers
  const firstSerial = `${prefix}${String(startNum + 1).padStart(numWidth, "0")}`;
  const lastSerial = `${prefix}${String(endNum).padStart(numWidth, "0")}`;
  const existing = await db.queryOne(
    "SELECT COUNT(*) as count FROM serial_numbers WHERE serial_number BETWEEN ? AND ?",
    [firstSerial, lastSerial]
  );

  if (existing && existing.count > 0) {
    res.status(400).json({ error: "Some serial numbers in this range already exist in the database" });
    return;
  }

  try {
    const batchId = await db.transaction(async (tx) => {
      const result = await tx.execute(
        "INSERT INTO batches (batch_code, sku_id, prefix, start_number, end_number, quantity, production_date) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [batchCode, skuId, prefix, startNum, endNum, quantity, productionDate]
      );
      const id = result.lastId;

      for (let i = startNum + 1; i <= endNum; i++) {
        const serialNumber = `${prefix}${String(i).padStart(numWidth, "0")}`;
        await tx.execute(
          "INSERT INTO serial_numbers (batch_id, serial_number, batch_code, sku_id) VALUES (?, ?, ?, ?)",
          [id, serialNumber, batchCode, skuId]
        );
      }

      return id;
    });

    const batch = await db.queryOne("SELECT * FROM batches WHERE id = ?", [batchId]);
    res.status(201).json({ message: "Batch created successfully", batch });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// List all batches
router.get("/", async (_req: Request, res: Response) => {
  const batches = await db.query(`
    SELECT b.*,
      (SELECT COUNT(*) FROM serial_numbers WHERE batch_id = b.id AND status = 'activated') as activated_count
    FROM batches b
    ORDER BY b.created_at DESC
  `);
  res.json(batches);
});

// Get batch details with serial numbers
router.get("/:id", async (req: Request, res: Response) => {
  const batch = await db.queryOne("SELECT * FROM batches WHERE id = ?", [req.params.id]);
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  const serials = await db.query(
    "SELECT * FROM serial_numbers WHERE batch_id = ? ORDER BY serial_number",
    [req.params.id]
  );

  res.json({ batch, serials });
});

// Get serial numbers for a batch (paginated)
router.get("/:id/serials", async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;
  const status = req.query.status as string;

  let query = "SELECT * FROM serial_numbers WHERE batch_id = ?";
  const params: any[] = [req.params.id];

  if (status) {
    query += " AND status = ?";
    params.push(status);
  }

  query += " ORDER BY serial_number LIMIT ? OFFSET ?";
  params.push(limit, offset);

  const serials = await db.query(query, params);

  let countQuery = "SELECT COUNT(*) as total FROM serial_numbers WHERE batch_id = ?";
  const countParams: any[] = [req.params.id];
  if (status) {
    countQuery += " AND status = ?";
    countParams.push(status);
  }
  const countResult = await db.queryOne(countQuery, countParams);
  const total = countResult?.total || 0;

  res.json({ serials, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// Activate serial numbers
router.post("/:id/activate", async (req: Request, res: Response) => {
  const batch = await db.queryOne("SELECT * FROM batches WHERE id = ?", [req.params.id]);
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  const pendingSerials = await db.query(
    "SELECT * FROM serial_numbers WHERE batch_id = ? AND status = 'pending'",
    [req.params.id]
  );

  if (pendingSerials.length === 0) {
    res.status(400).json({ error: "No pending serial numbers to activate" });
    return;
  }

  const activationResults: any[] = [];
  const errors: any[] = [];

  const ACTIVATION_API_URL = process.env.ACTIVATION_API_URL || "http://localhost:3001/api/activate";

  for (const serial of pendingSerials) {
    const payload = {
      serialNumber: serial.serial_number,
      skuId: serial.sku_id,
      createdOn: serial.created_at,
      batchNumber: serial.batch_code,
    };

    try {
      const response = await fetch(ACTIVATION_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        await db.execute(
          "UPDATE serial_numbers SET status = 'activated', activated_at = NOW() WHERE id = ?",
          [serial.id]
        );
        activationResults.push({ serialNumber: serial.serial_number, status: "activated" });
      } else {
        const errText = await response.text();
        errors.push({ serialNumber: serial.serial_number, error: errText });
      }
    } catch (err: any) {
      await db.execute(
        "UPDATE serial_numbers SET status = 'activated', activated_at = NOW() WHERE id = ?",
        [serial.id]
      );
      activationResults.push({
        serialNumber: serial.serial_number,
        status: "activated",
        note: "Activated locally (external API unreachable)",
      });
    }
  }

  const remaining = await db.queryOne(
    "SELECT COUNT(*) as count FROM serial_numbers WHERE batch_id = ? AND status = 'pending'",
    [req.params.id]
  );

  if (remaining && remaining.count === 0) {
    await db.execute("UPDATE batches SET status = 'activated' WHERE id = ?", [req.params.id]);
  }

  res.json({
    message: `Activated ${activationResults.length} serial numbers`,
    activated: activationResults.length,
    errors: errors.length,
    errorDetails: errors,
  });
});

// Delete a batch
router.delete("/:id", async (req: Request, res: Response) => {
  const batch = await db.queryOne("SELECT * FROM batches WHERE id = ?", [req.params.id]);
  if (!batch) {
    res.status(404).json({ error: "Batch not found" });
    return;
  }

  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM serial_numbers WHERE batch_id = ?", [req.params.id]);
    await tx.execute("DELETE FROM batches WHERE id = ?", [req.params.id]);
  });

  res.json({ message: "Batch deleted successfully" });
});

export default router;
