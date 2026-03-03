import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Pool } from "pg";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Convert ? placeholders to $1, $2, ...
function pg(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

let initialized = false;

async function init() {
  if (initialized) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id SERIAL PRIMARY KEY,
      batch_code TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      prefix TEXT NOT NULL,
      start_number INTEGER NOT NULL,
      end_number INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      production_date TEXT NOT NULL,
      role_number TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL DEFAULT 'created'
    );
    CREATE TABLE IF NOT EXISTS serial_numbers (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER NOT NULL REFERENCES batches(id),
      serial_number TEXT NOT NULL UNIQUE,
      batch_code TEXT NOT NULL,
      sku_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      activated_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_serial_number ON serial_numbers(serial_number);
    CREATE INDEX IF NOT EXISTS idx_batch_id ON serial_numbers(batch_id);
    CREATE INDEX IF NOT EXISTS idx_serial_status ON serial_numbers(status);
  `);
  // Add role_number column if it doesn't exist (migration)
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE batches ADD COLUMN role_number TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);
  // API logs table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS api_logs (
      id SERIAL PRIMARY KEY,
      endpoint TEXT NOT NULL,
      method TEXT NOT NULL,
      request_params JSONB,
      response_data JSONB,
      status_code INTEGER NOT NULL,
      success BOOLEAN NOT NULL,
      error_message TEXT,
      batches_count INTEGER DEFAULT 0,
      serials_activated INTEGER DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at);
  `);
  initialized = true;
}

function getPath(url: string): string {
  const u = new URL(url, "http://localhost");
  return u.pathname.replace(/^\/api/, "");
}

function getQuery(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await init();

  const path = getPath(req.url || "");
  const method = req.method || "GET";

  try {
    // GET /api/health
    if (path === "/health" && method === "GET") {
      return res.json({ status: "ok", timestamp: new Date().toISOString() });
    }

    // POST /api/batches
    if (path === "/batches" && method === "POST") {
      return await createBatch(req, res);
    }

    // GET /api/batches
    if (path === "/batches" && method === "GET") {
      return await listBatches(req, res);
    }

    // GET /api/batches/search
    if (path === "/batches/search" && method === "GET") {
      return await searchBatchesAndSerials(req, res);
    }

    // GET /api/batches/export
    if (path === "/batches/export" && method === "GET") {
      return await exportBatches(req, res);
    }

    // GET /api/logs
    if (path === "/logs" && method === "GET") {
      return await getApiLogs(req, res);
    }

    // GET /api/batches/:id/serials
    const serialsMatch = path.match(/^\/batches\/(\d+)\/serials$/);
    if (serialsMatch && method === "GET") {
      return await getBatchSerials(req, res, parseInt(serialsMatch[1]));
    }

    // POST /api/batches/:id/activate
    const activateMatch = path.match(/^\/batches\/(\d+)\/activate$/);
    if (activateMatch && method === "POST") {
      return await activateBatch(req, res, parseInt(activateMatch[1]));
    }

    // DELETE /api/batches/:id
    const deleteMatch = path.match(/^\/batches\/(\d+)$/);
    if (deleteMatch && method === "DELETE") {
      return await deleteBatch(req, res, parseInt(deleteMatch[1]));
    }

    // GET /api/batches/:id
    const detailMatch = path.match(/^\/batches\/(\d+)$/);
    if (detailMatch && method === "GET") {
      return await getBatchDetail(req, res, parseInt(detailMatch[1]));
    }

    return res.status(404).json({ error: "Not found" });
  } catch (err: any) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

async function createBatch(req: VercelRequest, res: VercelResponse) {
  const { ranges, batchCode, skuId, productionDate, roleNumber } = req.body;

  if (!batchCode || !skuId || !productionDate) {
    return res.status(400).json({ error: "Batch code, SKU ID, and production date are required" });
  }

  if (!ranges || !Array.isArray(ranges) || ranges.length === 0) {
    return res.status(400).json({ error: "At least one serial number range is required" });
  }

  // Validate and parse all ranges
  const parsedRanges: { prefix: string; startNum: number; endNum: number; width: number; quantity: number }[] = [];

  for (const range of ranges) {
    const startMatch = range.startSerial?.match(/^([A-Za-z])(\d+)$/);
    const endMatch = range.endSerial?.match(/^([A-Za-z])(\d+)$/);

    if (!startMatch || !endMatch) {
      return res.status(400).json({ error: `Invalid serial format: ${range.startSerial} - ${range.endSerial}` });
    }

    const prefix = startMatch[1].toUpperCase();
    const endPrefix = endMatch[1].toUpperCase();

    if (prefix !== endPrefix) {
      return res.status(400).json({ error: `Prefix mismatch: ${range.startSerial} vs ${range.endSerial}` });
    }

    const startNum = parseInt(startMatch[2], 10);
    const endNum = parseInt(endMatch[2], 10);

    if (endNum <= startNum) {
      return res.status(400).json({ error: `End must be greater than start: ${range.startSerial} - ${range.endSerial}` });
    }

    const width = Math.max(startMatch[2].length, endMatch[2].length);
    parsedRanges.push({ prefix, startNum, endNum, width, quantity: endNum - startNum });
  }

  const totalQuantity = parsedRanges.reduce((sum, r) => sum + r.quantity, 0);

  // Check for overlapping serial numbers in all ranges
  for (const r of parsedRanges) {
    const firstSerial = `${r.prefix}${String(r.startNum + 1).padStart(r.width, "0")}`;
    const lastSerial = `${r.prefix}${String(r.endNum).padStart(r.width, "0")}`;
    const existing = await pool.query(
      pg("SELECT COUNT(*) as count FROM serial_numbers WHERE serial_number BETWEEN ? AND ?"),
      [firstSerial, lastSerial]
    );
    if (parseInt(existing.rows[0].count) > 0) {
      return res.status(400).json({ error: `Serial numbers in range ${firstSerial}-${lastSerial} already exist` });
    }
  }

  // Use first range's prefix/start/end for the batch record summary
  const firstRange = parsedRanges[0];
  const lastRange = parsedRanges[parsedRanges.length - 1];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchResult = await client.query(
      pg("INSERT INTO batches (batch_code, sku_id, prefix, start_number, end_number, quantity, production_date, role_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id"),
      [batchCode, skuId, firstRange.prefix, firstRange.startNum, lastRange.endNum, totalQuantity, productionDate, roleNumber || null]
    );
    const batchId = batchResult.rows[0].id;

    for (const r of parsedRanges) {
      for (let i = r.startNum + 1; i <= r.endNum; i++) {
        const serialNumber = `${r.prefix}${String(i).padStart(r.width, "0")}`;
        await client.query(
          pg("INSERT INTO serial_numbers (batch_id, serial_number, batch_code, sku_id) VALUES (?, ?, ?, ?)"),
          [batchId, serialNumber, batchCode, skuId]
        );
      }
    }

    await client.query("COMMIT");

    // Collect all generated serial numbers
    const allSerials: string[] = [];
    for (const r of parsedRanges) {
      for (let i = r.startNum + 1; i <= r.endNum; i++) {
        allSerials.push(`${r.prefix}${String(i).padStart(r.width, "0")}`);
      }
    }

    // Call external activation API
    const EXTERNAL_API_URL = process.env.EXTERNAL_API_URL;
    let externalApiResult: any = null;

    const externalPayload = {
      batchCode,
      skuId,
      productionDate,
      roleNumber: roleNumber || null,
      quantity: totalQuantity,
      serialNumbers: allSerials.join(","),
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
      } catch (err: any) {
        externalApiResult = {
          status: 0,
          success: false,
          response: err.message,
        };
      }
    } else {
      externalApiResult = {
        status: 0,
        success: false,
        response: "No EXTERNAL_API_URL configured. Set it in environment variables.",
      };
    }

    const batch = await pool.query(pg("SELECT * FROM batches WHERE id = ?"), [batchId]);
    return res.status(201).json({
      message: "Batch created successfully",
      batch: batch.rows[0],
      externalApi: externalApiResult,
      samplePayloadSent: externalPayload,
    });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function listBatches(_req: VercelRequest, res: VercelResponse) {
  const result = await pool.query(`
    SELECT b.*,
      (SELECT COUNT(*) FROM serial_numbers WHERE batch_id = b.id AND status = 'activated') as activated_count
    FROM batches b
    ORDER BY b.created_at DESC
  `);
  return res.json(result.rows);
}

async function getBatchDetail(_req: VercelRequest, res: VercelResponse, id: number) {
  const batch = await pool.query(pg("SELECT * FROM batches WHERE id = ?"), [id]);
  if (batch.rows.length === 0) {
    return res.status(404).json({ error: "Batch not found" });
  }

  const serials = await pool.query(
    pg("SELECT * FROM serial_numbers WHERE batch_id = ? ORDER BY serial_number"),
    [id]
  );

  return res.json({ batch: batch.rows[0], serials: serials.rows });
}

async function getBatchSerials(req: VercelRequest, res: VercelResponse, id: number) {
  const query = getQuery(req.url || "");
  const page = parseInt(query.get("page") || "1");
  const limit = parseInt(query.get("limit") || "50");
  const offset = (page - 1) * limit;
  const status = query.get("status");

  let sql = "SELECT * FROM serial_numbers WHERE batch_id = $1";
  const params: any[] = [id];

  if (status) {
    sql += ` AND status = $${params.length + 1}`;
    params.push(status);
  }

  sql += ` ORDER BY serial_number LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const serials = await pool.query(sql, params);

  let countSql = "SELECT COUNT(*) as total FROM serial_numbers WHERE batch_id = $1";
  const countParams: any[] = [id];
  if (status) {
    countSql += " AND status = $2";
    countParams.push(status);
  }
  const countResult = await pool.query(countSql, countParams);
  const total = parseInt(countResult.rows[0].total);

  return res.json({ serials: serials.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
}

async function activateBatch(_req: VercelRequest, res: VercelResponse, id: number) {
  const batch = await pool.query(pg("SELECT * FROM batches WHERE id = ?"), [id]);
  if (batch.rows.length === 0) {
    return res.status(404).json({ error: "Batch not found" });
  }

  const pending = await pool.query(
    pg("SELECT * FROM serial_numbers WHERE batch_id = ? AND status = 'pending'"),
    [id]
  );

  if (pending.rows.length === 0) {
    return res.status(400).json({ error: "No pending serial numbers to activate" });
  }

  const ACTIVATION_API_URL = process.env.ACTIVATION_API_URL;
  const activationResults: any[] = [];
  const errors: any[] = [];

  for (const serial of pending.rows) {
    const payload = {
      serialNumber: serial.serial_number,
      skuId: serial.sku_id,
      createdOn: serial.created_at,
      batchNumber: serial.batch_code,
    };

    let activated = false;
    if (ACTIVATION_API_URL) {
      try {
        const response = await fetch(ACTIVATION_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (response.ok) activated = true;
        else errors.push({ serialNumber: serial.serial_number, error: await response.text() });
      } catch {
        activated = true; // activate locally if API unreachable
      }
    } else {
      activated = true; // no external API configured, activate locally
    }

    if (activated) {
      await pool.query(pg("UPDATE serial_numbers SET status = 'activated', activated_at = NOW() WHERE id = ?"), [serial.id]);
      activationResults.push({ serialNumber: serial.serial_number, status: "activated" });
    }
  }

  const remaining = await pool.query(
    pg("SELECT COUNT(*) as count FROM serial_numbers WHERE batch_id = ? AND status = 'pending'"),
    [id]
  );

  if (parseInt(remaining.rows[0].count) === 0) {
    await pool.query(pg("UPDATE batches SET status = 'activated' WHERE id = ?"), [id]);
  }

  return res.json({
    message: `Activated ${activationResults.length} serial numbers`,
    activated: activationResults.length,
    errors: errors.length,
    errorDetails: errors,
  });
}

async function searchBatchesAndSerials(req: VercelRequest, res: VercelResponse) {
  const query = getQuery(req.url || "");
  const q = (query.get("q") || "").trim();

  if (!q) {
    return res.json([]);
  }

  const pattern = `%${q}%`;

  // Search batches by batch_code or role_number
  const batchResults = await pool.query(
    `SELECT *, id as batch_id, status as batch_status, created_at as batch_created_at
     FROM batches
     WHERE batch_code ILIKE $1 OR role_number ILIKE $1 OR sku_id ILIKE $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [pattern]
  );

  // Search serial numbers
  const serialResults = await pool.query(
    `SELECT s.serial_number, s.status as serial_status, s.created_at as serial_created_at,
            s.activated_at as serial_activated_at,
            b.batch_code, b.sku_id, b.role_number, b.production_date, b.quantity,
            b.prefix, b.start_number, b.end_number, b.id as batch_id,
            b.status as batch_status, b.created_at as batch_created_at
     FROM serial_numbers s
     JOIN batches b ON s.batch_id = b.id
     WHERE s.serial_number ILIKE $1
     ORDER BY s.serial_number
     LIMIT 50`,
    [pattern]
  );

  const results: any[] = [];

  for (const row of batchResults.rows) {
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

  for (const row of serialResults.rows) {
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

  return res.json(results);
}

async function deleteBatch(_req: VercelRequest, res: VercelResponse, id: number) {
  const batch = await pool.query(pg("SELECT * FROM batches WHERE id = ?"), [id]);
  if (batch.rows.length === 0) {
    return res.status(404).json({ error: "Batch not found" });
  }

  await pool.query(pg("DELETE FROM serial_numbers WHERE batch_id = ?"), [id]);
  await pool.query(pg("DELETE FROM batches WHERE id = ?"), [id]);

  return res.json({ message: "Batch deleted successfully" });
}

async function exportBatches(req: VercelRequest, res: VercelResponse) {
  const query = getQuery(req.url || "");
  const from = query.get("from");
  const to = query.get("to");

  if (!from || !to) {
    const errorResp = { error: "Both 'from' and 'to' date parameters are required (YYYY-MM-DD)" };
    await logApiCall("/batches/export", "GET", { from, to }, errorResp, 400, false, errorResp.error, 0, 0);
    return res.status(400).json(errorResp);
  }

  try {
    // Fetch all batches created in the date range
    const batchResult = await pool.query(
      `SELECT b.*,
        (SELECT COUNT(*) FROM serial_numbers WHERE batch_id = b.id AND status = 'activated') as activated_count
       FROM batches b
       WHERE b.created_at >= $1::date AND b.created_at < ($2::date + INTERVAL '1 day')
       ORDER BY b.created_at DESC`,
      [from, to]
    );

    if (batchResult.rows.length === 0) {
      const resp = { message: "No batches found in the given date range", batches: [], totalBatches: 0, totalSerials: 0, serialsActivated: 0 };
      await logApiCall("/batches/export", "GET", { from, to }, resp, 200, true, null, 0, 0);
      return res.json(resp);
    }

    // Fetch all serial numbers for these batches
    const batchIds = batchResult.rows.map((b: any) => b.id);
    const serialResult = await pool.query(
      `SELECT * FROM serial_numbers WHERE batch_id = ANY($1) ORDER BY batch_id, serial_number`,
      [batchIds]
    );

    // Activate all pending serial numbers for these batches
    const activateResult = await pool.query(
      `UPDATE serial_numbers SET status = 'activated', activated_at = NOW()
       WHERE batch_id = ANY($1) AND status = 'pending'
       RETURNING id`,
      [batchIds]
    );
    const serialsActivated = activateResult.rowCount || 0;

    // Update batch status if all serials are now activated
    for (const batchId of batchIds) {
      const remaining = await pool.query(
        pg("SELECT COUNT(*) as count FROM serial_numbers WHERE batch_id = ? AND status = 'pending'"),
        [batchId]
      );
      if (parseInt(remaining.rows[0].count) === 0) {
        await pool.query(pg("UPDATE batches SET status = 'activated' WHERE id = ?"), [batchId]);
      }
    }

    // Group serials by batch
    const serialsByBatch: Record<number, any[]> = {};
    for (const s of serialResult.rows) {
      if (!serialsByBatch[s.batch_id]) serialsByBatch[s.batch_id] = [];
      serialsByBatch[s.batch_id].push(s);
    }

    const batches = batchResult.rows.map((b: any) => ({
      ...b,
      serials: serialsByBatch[b.id] || [],
    }));

    const resp = {
      message: `Found ${batches.length} batches. Activated ${serialsActivated} serial numbers.`,
      totalBatches: batches.length,
      totalSerials: serialResult.rows.length,
      serialsActivated,
      from,
      to,
      batches,
    };

    await logApiCall("/batches/export", "GET", { from, to }, { message: resp.message, totalBatches: resp.totalBatches, totalSerials: resp.totalSerials, serialsActivated: resp.serialsActivated }, 200, true, null, batches.length, serialsActivated);
    return res.json(resp);
  } catch (err: any) {
    const errorResp = { error: err.message };
    await logApiCall("/batches/export", "GET", { from, to }, errorResp, 500, false, err.message, 0, 0);
    return res.status(500).json(errorResp);
  }
}

async function logApiCall(
  endpoint: string, method: string, requestParams: any, responseData: any,
  statusCode: number, success: boolean, errorMessage: string | null,
  batchesCount: number, serialsActivated: number
) {
  try {
    await pool.query(
      `INSERT INTO api_logs (endpoint, method, request_params, response_data, status_code, success, error_message, batches_count, serials_activated)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [endpoint, method, JSON.stringify(requestParams), JSON.stringify(responseData), statusCode, success, errorMessage, batchesCount, serialsActivated]
    );
  } catch (e) {
    console.error("Failed to log API call:", e);
  }
}

async function getApiLogs(req: VercelRequest, res: VercelResponse) {
  const query = getQuery(req.url || "");
  const page = parseInt(query.get("page") || "1");
  const limit = parseInt(query.get("limit") || "50");
  const offset = (page - 1) * limit;

  const logs = await pool.query(
    `SELECT * FROM api_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  const countResult = await pool.query("SELECT COUNT(*) as total FROM api_logs");
  const total = parseInt(countResult.rows[0].total);

  return res.json({ logs: logs.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
}
