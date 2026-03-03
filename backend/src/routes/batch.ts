import { Router, Request, Response } from "express";
import db from "../db";

const router = Router();

async function logApiCall(
  db: any, endpoint: string, method: string, requestParams: any, responseData: any,
  statusCode: number, success: boolean, errorMessage: string | null,
  batchesCount: number, serialsActivated: number
) {
  try {
    await db.execute(
      "INSERT INTO api_logs (endpoint, method, request_params, response_data, status_code, success, error_message, batches_count, serials_activated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [endpoint, method, JSON.stringify(requestParams), JSON.stringify(responseData), statusCode, success ? 1 : 0, errorMessage, batchesCount, serialsActivated]
    );
  } catch (e) {
    console.error("Failed to log API call:", e);
  }
}

// Create a new batch
router.post("/", async (req: Request, res: Response) => {
  const { ranges, batchCode, skuId, productionDate, roleNumber } = req.body;

  if (!batchCode || !skuId || !productionDate) {
    res.status(400).json({ error: "Batch code, SKU ID, and production date are required" });
    return;
  }

  if (!ranges || !Array.isArray(ranges) || ranges.length === 0) {
    res.status(400).json({ error: "At least one serial number range is required" });
    return;
  }

  const parsedRanges: { prefix: string; startNum: number; endNum: number; width: number; quantity: number }[] = [];

  for (const range of ranges) {
    const startMatch = range.startSerial?.match(/^([A-Za-z])(\d+)$/);
    const endMatch = range.endSerial?.match(/^([A-Za-z])(\d+)$/);

    if (!startMatch || !endMatch) {
      res.status(400).json({ error: `Invalid serial format: ${range.startSerial} - ${range.endSerial}` });
      return;
    }

    const prefix = startMatch[1].toUpperCase();
    const endPrefix = endMatch[1].toUpperCase();

    if (prefix !== endPrefix) {
      res.status(400).json({ error: `Prefix mismatch: ${range.startSerial} vs ${range.endSerial}` });
      return;
    }

    const startNum = parseInt(startMatch[2], 10);
    const endNum = parseInt(endMatch[2], 10);

    if (endNum <= startNum) {
      res.status(400).json({ error: `End must be greater than start: ${range.startSerial} - ${range.endSerial}` });
      return;
    }

    const width = Math.max(startMatch[2].length, endMatch[2].length);
    parsedRanges.push({ prefix, startNum, endNum, width, quantity: endNum - startNum });
  }

  const totalQuantity = parsedRanges.reduce((sum, r) => sum + r.quantity, 0);

  for (const r of parsedRanges) {
    const firstSerial = `${r.prefix}${String(r.startNum + 1).padStart(r.width, "0")}`;
    const lastSerial = `${r.prefix}${String(r.endNum).padStart(r.width, "0")}`;
    const existing = await db.queryOne(
      "SELECT COUNT(*) as count FROM serial_numbers WHERE serial_number BETWEEN ? AND ?",
      [firstSerial, lastSerial]
    );
    if (existing && existing.count > 0) {
      res.status(400).json({ error: `Serial numbers in range ${firstSerial}-${lastSerial} already exist` });
      return;
    }
  }

  const firstRange = parsedRanges[0];
  const lastRange = parsedRanges[parsedRanges.length - 1];

  try {
    const batchId = await db.transaction(async (tx) => {
      const result = await tx.execute(
        "INSERT INTO batches (batch_code, sku_id, prefix, start_number, end_number, quantity, production_date, role_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [batchCode, skuId, firstRange.prefix, firstRange.startNum, lastRange.endNum, totalQuantity, productionDate, roleNumber || null]
      );
      const id = result.lastId;

      for (const r of parsedRanges) {
        for (let i = r.startNum + 1; i <= r.endNum; i++) {
          const serialNumber = `${r.prefix}${String(i).padStart(r.width, "0")}`;
          await tx.execute(
            "INSERT INTO serial_numbers (batch_id, serial_number, batch_code, sku_id) VALUES (?, ?, ?, ?)",
            [id, serialNumber, batchCode, skuId]
          );
        }
      }

      return id;
    });

    // Collect all generated serial numbers
    const allSerials: string[] = [];
    for (const r of parsedRanges) {
      for (let i = r.startNum + 1; i <= r.endNum; i++) {
        allSerials.push(`${r.prefix}${String(i).padStart(r.width, "0")}`);
      }
    }

    // Call external activation API (URL from DB settings or env var)
    const urlSetting = await db.queryOne("SELECT value FROM settings WHERE key = 'external_api_url'");
    const EXTERNAL_API_URL = urlSetting?.value || process.env.EXTERNAL_API_URL;
    let externalApiResult: any = null;

    const externalPayload = {
      SerialBatchNumber: allSerials.join(","),
    };

    if (EXTERNAL_API_URL) {
      try {
        const extResponse = await fetch(EXTERNAL_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(externalPayload),
        });
        const extBody = await extResponse.text();
        externalApiResult = {
          status: extResponse.status,
          success: extResponse.ok,
          response: extBody,
        };
      } catch (err2: any) {
        externalApiResult = {
          status: 0,
          success: false,
          response: err2.message,
        };
      }
    } else {
      externalApiResult = {
        status: 0,
        success: false,
        response: "No External API URL configured. Set it in the API Logs page.",
      };
    }

    // Log external API call
    await logApiCall(
      db,
      EXTERNAL_API_URL || "/external-api (not configured)",
      "POST",
      { batchCode, serialCount: allSerials.length, payload: externalPayload },
      externalApiResult,
      externalApiResult.status,
      externalApiResult.success,
      externalApiResult.success ? null : externalApiResult.response,
      1,
      0
    );

    const batch = await db.queryOne("SELECT * FROM batches WHERE id = ?", [batchId]);
    res.status(201).json({
      message: "Batch created successfully",
      batch,
      externalApi: externalApiResult,
      samplePayloadSent: externalPayload,
    });
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

// Search batches and serial numbers
router.get("/search", async (req: Request, res: Response) => {
  const q = ((req.query.q as string) || "").trim();
  if (!q) {
    res.json([]);
    return;
  }

  const pattern = `%${q}%`;

  const batchRows = await db.query(
    "SELECT *, id as batch_id, status as batch_status, created_at as batch_created_at FROM batches WHERE batch_code LIKE ? OR role_number LIKE ? OR sku_id LIKE ? ORDER BY created_at DESC LIMIT 50",
    [pattern, pattern, pattern]
  );

  const serialRows = await db.query(
    `SELECT s.serial_number, s.status as serial_status, s.created_at as serial_created_at,
            s.activated_at as serial_activated_at,
            b.batch_code, b.sku_id, b.role_number, b.production_date, b.quantity,
            b.prefix, b.start_number, b.end_number, b.id as batch_id,
            b.status as batch_status, b.created_at as batch_created_at
     FROM serial_numbers s
     JOIN batches b ON s.batch_id = b.id
     WHERE s.serial_number LIKE ?
     ORDER BY s.serial_number
     LIMIT 50`,
    [pattern]
  );

  const results: any[] = [];

  for (const row of batchRows) {
    results.push({
      type: "batch",
      batch_code: row.batch_code,
      sku_id: row.sku_id,
      role_number: row.role_number,
      production_date: row.production_date,
      quantity: row.quantity,
      prefix: row.prefix,
      start_number: row.start_number,
      end_number: row.end_number,
      batch_id: row.batch_id,
      batch_status: row.batch_status,
      batch_created_at: row.batch_created_at,
    });
  }

  for (const row of serialRows) {
    results.push({
      type: "serial",
      serial_number: row.serial_number,
      batch_code: row.batch_code,
      sku_id: row.sku_id,
      role_number: row.role_number,
      production_date: row.production_date,
      quantity: row.quantity,
      prefix: row.prefix,
      start_number: row.start_number,
      end_number: row.end_number,
      batch_id: row.batch_id,
      batch_status: row.batch_status,
      serial_status: row.serial_status,
      serial_created_at: row.serial_created_at,
      serial_activated_at: row.serial_activated_at,
      batch_created_at: row.batch_created_at,
    });
  }

  res.json(results);
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

// Export batches by created date range and activate serials
router.get("/export", async (req: Request, res: Response) => {
  const from = req.query.from as string;
  const to = req.query.to as string;

  if (!from || !to) {
    const errorResp = { error: "Both 'from' and 'to' date parameters are required (YYYY-MM-DD)" };
    await logApiCall(db, "/batches/export", "GET", { from, to }, errorResp, 400, false, errorResp.error, 0, 0);
    res.status(400).json(errorResp);
    return;
  }

  try {
    const batches = await db.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM serial_numbers WHERE batch_id = b.id AND status = 'activated') as activated_count
       FROM batches b
       WHERE b.created_at >= ? AND b.created_at < date(?, '+1 day')
       ORDER BY b.created_at DESC`,
      [from, to]
    );

    if (batches.length === 0) {
      const resp = { message: "No batches found in the given date range", batches: [], totalBatches: 0, totalSerials: 0, serialsActivated: 0 };
      await logApiCall(db, "/batches/export", "GET", { from, to }, resp, 200, true, null, 0, 0);
      res.json(resp);
      return;
    }

    const batchIds = batches.map((b: any) => b.id);
    let allSerials: any[] = [];
    let serialsActivated = 0;

    for (const batchId of batchIds) {
      const serials = await db.query("SELECT * FROM serial_numbers WHERE batch_id = ? ORDER BY serial_number", [batchId]);
      allSerials.push(...serials.map((s: any) => ({ ...s, _batch_id: batchId })));

      // Activate pending serials
      await db.execute("UPDATE serial_numbers SET status = 'activated', activated_at = NOW() WHERE batch_id = ? AND status = 'pending'", [batchId]);

      const activated = serials.filter((s: any) => s.status === 'pending').length;
      serialsActivated += activated;

      // Update batch status
      const remaining = await db.queryOne("SELECT COUNT(*) as count FROM serial_numbers WHERE batch_id = ? AND status = 'pending'", [batchId]);
      if (remaining && remaining.count === 0) {
        await db.execute("UPDATE batches SET status = 'activated' WHERE id = ?", [batchId]);
      }
    }

    const serialsByBatch: Record<number, any[]> = {};
    for (const s of allSerials) {
      const bid = s._batch_id || s.batch_id;
      if (!serialsByBatch[bid]) serialsByBatch[bid] = [];
      serialsByBatch[bid].push(s);
    }

    const result = batches.map((b: any) => ({
      ...b,
      serials: serialsByBatch[b.id] || [],
    }));

    const resp = {
      message: `Found ${result.length} batches. Activated ${serialsActivated} serial numbers.`,
      totalBatches: result.length,
      totalSerials: allSerials.length,
      serialsActivated,
      from,
      to,
      batches: result,
    };

    await logApiCall(db, "/batches/export", "GET", { from, to }, { message: resp.message, totalBatches: resp.totalBatches, totalSerials: resp.totalSerials, serialsActivated: resp.serialsActivated }, 200, true, null, result.length, serialsActivated);
    res.json(resp);
  } catch (err: any) {
    const errorResp = { error: err.message };
    await logApiCall(db, "/batches/export", "GET", { from, to }, errorResp, 500, false, err.message, 0, 0);
    res.status(500).json(errorResp);
  }
});

// Get API logs
router.get("/logs", async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 50;
  const offset = (page - 1) * limit;

  const logs = await db.query("SELECT * FROM api_logs ORDER BY created_at DESC LIMIT ? OFFSET ?", [limit, offset]);
  const countResult = await db.queryOne("SELECT COUNT(*) as total FROM api_logs");
  const total = countResult?.total || 0;

  res.json({ logs, total, page, limit, totalPages: Math.ceil(total / limit) });
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
