import type { VercelRequest, VercelResponse } from "@vercel/node";
import { Pool } from "pg";
import * as XLSX from "xlsx";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
  idleTimeoutMillis: 20000,
  connectionTimeoutMillis: 10000,
});

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
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
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
  await pool.query(`
    DO $$ BEGIN
      ALTER TABLE batches ADD COLUMN role_number TEXT;
    EXCEPTION WHEN duplicate_column THEN NULL;
    END $$;
  `);
  initialized = true;
}

function getPath(url: string): string {
  return new URL(url, "http://localhost").pathname.replace(/^\/api/, "");
}

function getQuery(url: string): URLSearchParams {
  return new URL(url, "http://localhost").searchParams;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  await init();

  const path = getPath(req.url || "");
  const method = req.method || "GET";

  try {
    if (path === "/health" && method === "GET") {
      return res.json({ status: "ok" });
    }
    if (path === "/batches" && method === "POST") {
      return await createBatch(req, res);
    }
    if (path === "/batches" && method === "GET") {
      return await listBatches(res);
    }
    if (path === "/batches/search" && method === "GET") {
      return await searchBatchesAndSerials(req, res);
    }
    if (path === "/batches/export" && method === "GET") {
      return await exportBatches(req, res);
    }
    if (path === "/batches/download" && method === "GET") {
      return await downloadBatches(res);
    }
    if (path === "/logs" && method === "GET") {
      return await getApiLogs(req, res);
    }
    if (path === "/settings" && method === "GET") {
      return await getSettings(res);
    }
    if (path === "/settings" && method === "PUT") {
      return await updateSettings(req, res);
    }

    const serialsMatch = path.match(/^\/batches\/(\d+)\/serials$/);
    if (serialsMatch && method === "GET") {
      return await getBatchSerials(req, res, parseInt(serialsMatch[1]));
    }

    const activateMatch = path.match(/^\/batches\/(\d+)\/activate$/);
    if (activateMatch && method === "POST") {
      return await activateBatch(res, parseInt(activateMatch[1]));
    }

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

// ─── CREATE BATCH (optimised for 15k+ serials) ───

async function createBatch(req: VercelRequest, res: VercelResponse) {
  const { ranges, batchCode, skuId, productionDate, roleNumber } = req.body;

  if (!batchCode || !skuId || !productionDate) {
    return res.status(400).json({ error: "Batch code, SKU ID, and production date are required" });
  }
  if (!ranges || !Array.isArray(ranges) || ranges.length === 0) {
    return res.status(400).json({ error: "At least one serial number range is required" });
  }

  // Validate ranges (pure CPU, no DB)
  const parsedRanges: { prefix: string; startNum: number; endNum: number; width: number; quantity: number }[] = [];
  for (const range of ranges) {
    const startMatch = range.startSerial?.match(/^([A-Za-z])(\d+)$/);
    const endMatch = range.endSerial?.match(/^([A-Za-z])(\d+)$/);
    if (!startMatch || !endMatch) {
      return res.status(400).json({ error: `Invalid serial format: ${range.startSerial} - ${range.endSerial}` });
    }
    const prefix = startMatch[1].toUpperCase();
    if (prefix !== endMatch[1].toUpperCase()) {
      return res.status(400).json({ error: `Prefix mismatch: ${range.startSerial} vs ${range.endSerial}` });
    }
    const startNum = parseInt(startMatch[2], 10);
    const endNum = parseInt(endMatch[2], 10);
    if (endNum <= startNum) {
      return res.status(400).json({ error: `End must be greater than start: ${range.startSerial} - ${range.endSerial}` });
    }
    parsedRanges.push({ prefix, startNum, endNum, width: Math.max(startMatch[2].length, endMatch[2].length), quantity: endNum - startNum });
  }

  const totalQuantity = parsedRanges.reduce((sum, r) => sum + r.quantity, 0);

  // Generate all serial numbers once in memory
  const allSerials = new Array<string>(totalQuantity);
  let idx = 0;
  for (const r of parsedRanges) {
    for (let i = r.startNum + 1; i <= r.endNum; i++) {
      allSerials[idx++] = `${r.prefix}${String(i).padStart(r.width, "0")}`;
    }
  }

  // Overlap check: sample first & last of each range using indexed BETWEEN (fast)
  for (const r of parsedRanges) {
    const first = `${r.prefix}${String(r.startNum + 1).padStart(r.width, "0")}`;
    const last = `${r.prefix}${String(r.endNum).padStart(r.width, "0")}`;
    const dup = await pool.query(
      `SELECT 1 FROM serial_numbers WHERE serial_number BETWEEN $1 AND $2 LIMIT 1`,
      [first, last]
    );
    if (dup.rows.length > 0) {
      return res.status(400).json({ error: `Serial numbers in range ${first}-${last} already exist` });
    }
  }

  // Fetch settings outside transaction
  const urlSetting = await pool.query("SELECT value FROM settings WHERE key = 'external_api_url'");
  const EXTERNAL_API_URL = urlSetting.rows[0]?.value || process.env.EXTERNAL_API_URL;

  const firstRange = parsedRanges[0];
  const lastRange = parsedRanges[parsedRanges.length - 1];

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Insert batch as activated in one shot
    const batchResult = await client.query(
      `INSERT INTO batches (batch_code, sku_id, prefix, start_number, end_number, quantity, production_date, role_number, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'activated') RETURNING *`,
      [batchCode, skuId, firstRange.prefix, firstRange.startNum, lastRange.endNum, totalQuantity, productionDate, roleNumber || null]
    );
    const batch = batchResult.rows[0];

    // Bulk insert using unnest — 1 query per 5000 rows
    const CHUNK = 5000;
    for (let c = 0; c < allSerials.length; c += CHUNK) {
      await client.query(
        `INSERT INTO serial_numbers (batch_id, serial_number, batch_code, sku_id, status, activated_at)
         SELECT $1, unnest($2::text[]), $3, $4, 'activated', NOW()`,
        [batch.id, allSerials.slice(c, c + CHUNK), batchCode, skuId]
      );
    }

    await client.query("COMMIT");

    // External API call
    let externalApiResult: any;
    const externalPayload = { SerialBatchNumber: allSerials.join(",") };

    if (EXTERNAL_API_URL) {
      try {
        const r = await fetch(EXTERNAL_API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(externalPayload),
        });
        externalApiResult = { status: r.status, success: r.ok, response: await r.text() };
      } catch (err: any) {
        externalApiResult = { status: 0, success: false, response: err.message };
      }
    } else {
      externalApiResult = { status: 0, success: false, response: "No External API URL configured. Set it in the API Logs page." };
    }

    // Fire-and-forget log
    logApiCall(EXTERNAL_API_URL || "(not configured)", "POST",
      { batchCode, serialCount: totalQuantity }, externalApiResult,
      externalApiResult.status, externalApiResult.success,
      externalApiResult.success ? null : externalApiResult.response, 1, totalQuantity);

    return res.status(201).json({ message: "Batch created successfully", batch, externalApi: externalApiResult });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// ─── LIST BATCHES (single query, no correlated subquery) ───

async function listBatches(res: VercelResponse) {
  const result = await pool.query(`
    SELECT b.*, COALESCE(s.activated_count, 0) as activated_count
    FROM batches b
    LEFT JOIN (
      SELECT batch_id, COUNT(*) as activated_count
      FROM serial_numbers WHERE status = 'activated'
      GROUP BY batch_id
    ) s ON s.batch_id = b.id
    ORDER BY b.created_at DESC
  `);
  return res.json(result.rows);
}

// ─── BATCH DETAIL (batch + paginated serials) ───

async function getBatchDetail(req: VercelRequest, res: VercelResponse, id: number) {
  const query = getQuery(req.url || "");
  const limit = Math.min(parseInt(query.get("limit") || "100"), 500);
  const offset = parseInt(query.get("offset") || "0");

  const batch = await pool.query(`SELECT * FROM batches WHERE id = $1`, [id]);
  if (batch.rows.length === 0) {
    return res.status(404).json({ error: "Batch not found" });
  }

  const [serials, countResult] = await Promise.all([
    pool.query(`SELECT * FROM serial_numbers WHERE batch_id = $1 ORDER BY serial_number LIMIT $2 OFFSET $3`, [id, limit, offset]),
    pool.query(`SELECT COUNT(*) as total FROM serial_numbers WHERE batch_id = $1`, [id]),
  ]);

  return res.json({ batch: batch.rows[0], serials: serials.rows, total: parseInt(countResult.rows[0].total) });
}

// ─── PAGINATED SERIALS ───

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

  const countSql = sql.replace("SELECT *", "SELECT COUNT(*) as total");

  sql += ` ORDER BY serial_number LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const [serials, countResult] = await Promise.all([
    pool.query(sql, params),
    pool.query(countSql, params.slice(0, status ? 2 : 1)),
  ]);
  const total = parseInt(countResult.rows[0].total);

  return res.json({ serials: serials.rows, total, page, limit, totalPages: Math.ceil(total / limit) });
}

// ─── ACTIVATE BATCH (bulk, single query) ───

async function activateBatch(res: VercelResponse, id: number) {
  const batch = await pool.query(`SELECT id FROM batches WHERE id = $1`, [id]);
  if (batch.rows.length === 0) {
    return res.status(404).json({ error: "Batch not found" });
  }

  const result = await pool.query(
    `UPDATE serial_numbers SET status = 'activated', activated_at = NOW()
     WHERE batch_id = $1 AND status = 'pending' RETURNING id`,
    [id]
  );

  if (result.rowCount === 0) {
    return res.status(400).json({ error: "No pending serial numbers to activate" });
  }

  await pool.query(`UPDATE batches SET status = 'activated' WHERE id = $1`, [id]);

  return res.json({ message: `Activated ${result.rowCount} serial numbers`, activated: result.rowCount, errors: 0, errorDetails: [] });
}

// ─── SEARCH (parallel queries) ───

async function searchBatchesAndSerials(req: VercelRequest, res: VercelResponse) {
  const q = (getQuery(req.url || "").get("q") || "").trim();
  if (!q) return res.json([]);

  const pattern = `%${q}%`;

  const [batchResults, serialResults] = await Promise.all([
    pool.query(
      `SELECT *, id as batch_id, status as batch_status, created_at as batch_created_at
       FROM batches
       WHERE batch_code ILIKE $1 OR role_number ILIKE $1 OR sku_id ILIKE $1
       ORDER BY created_at DESC LIMIT 50`,
      [pattern]
    ),
    pool.query(
      `SELECT s.serial_number, s.status as serial_status, s.created_at as serial_created_at,
              s.activated_at as serial_activated_at,
              b.batch_code, b.sku_id, b.role_number, b.production_date, b.quantity,
              b.prefix, b.start_number, b.end_number, b.id as batch_id,
              b.status as batch_status, b.created_at as batch_created_at
       FROM serial_numbers s JOIN batches b ON s.batch_id = b.id
       WHERE s.serial_number ILIKE $1
       ORDER BY s.serial_number LIMIT 50`,
      [pattern]
    ),
  ]);

  const results: any[] = [];
  for (const row of batchResults.rows) {
    results.push({ type: "batch", batch_code: row.batch_code, sku_id: row.sku_id, role_number: row.role_number,
      production_date: row.production_date, quantity: row.quantity, prefix: row.prefix,
      start_number: row.start_number, end_number: row.end_number, batch_id: row.batch_id,
      batch_status: row.batch_status, batch_created_at: row.batch_created_at });
  }
  for (const row of serialResults.rows) {
    results.push({ type: "serial", serial_number: row.serial_number, batch_code: row.batch_code, sku_id: row.sku_id,
      role_number: row.role_number, production_date: row.production_date, quantity: row.quantity, prefix: row.prefix,
      start_number: row.start_number, end_number: row.end_number, batch_id: row.batch_id,
      batch_status: row.batch_status, serial_status: row.serial_status,
      serial_created_at: row.serial_created_at, serial_activated_at: row.serial_activated_at,
      batch_created_at: row.batch_created_at });
  }
  return res.json(results);
}

// ─── EXPORT BATCHES (bulk activate) ───

async function exportBatches(req: VercelRequest, res: VercelResponse) {
  const query = getQuery(req.url || "");
  const from = query.get("from");
  const to = query.get("to");

  if (!from || !to) {
    const err = { error: "Both 'from' and 'to' date parameters are required (YYYY-MM-DD)" };
    logApiCall("/batches/export", "GET", { from, to }, err, 400, false, err.error, 0, 0);
    return res.status(400).json(err);
  }

  try {
    const batchResult = await pool.query(
      `SELECT b.*, COALESCE(s.act, 0) as activated_count
       FROM batches b
       LEFT JOIN (SELECT batch_id, COUNT(*) as act FROM serial_numbers WHERE status='activated' GROUP BY batch_id) s ON s.batch_id = b.id
       WHERE b.created_at >= $1::date AND b.created_at < ($2::date + INTERVAL '1 day')
       ORDER BY b.created_at DESC`,
      [from, to]
    );

    if (batchResult.rows.length === 0) {
      const resp = { message: "No batches found in the given date range", batches: [], totalBatches: 0, totalSerials: 0, serialsActivated: 0 };
      logApiCall("/batches/export", "GET", { from, to }, resp, 200, true, null, 0, 0);
      return res.json(resp);
    }

    const batchIds = batchResult.rows.map((b: any) => b.id);

    // Parallel: fetch serials + bulk activate pending
    const [serialResult, activateResult] = await Promise.all([
      pool.query(`SELECT * FROM serial_numbers WHERE batch_id = ANY($1) ORDER BY batch_id, serial_number`, [batchIds]),
      pool.query(`UPDATE serial_numbers SET status='activated', activated_at=NOW() WHERE batch_id=ANY($1) AND status='pending' RETURNING id`, [batchIds]),
    ]);
    const serialsActivated = activateResult.rowCount || 0;

    // Bulk update batch status
    if (serialsActivated > 0) {
      await pool.query(
        `UPDATE batches SET status='activated' WHERE id=ANY($1) AND NOT EXISTS (
          SELECT 1 FROM serial_numbers WHERE batch_id=batches.id AND status='pending'
        )`, [batchIds]
      );
    }

    // Group serials by batch
    const serialsByBatch: Record<number, any[]> = {};
    for (const s of serialResult.rows) {
      (serialsByBatch[s.batch_id] ||= []).push(s);
    }

    const batches = batchResult.rows.map((b: any) => ({ ...b, serials: serialsByBatch[b.id] || [] }));

    const resp = {
      message: `Found ${batches.length} batches. Activated ${serialsActivated} serial numbers.`,
      totalBatches: batches.length, totalSerials: serialResult.rows.length,
      serialsActivated, from, to, batches,
    };

    logApiCall("/batches/export", "GET", { from, to },
      { message: resp.message, totalBatches: resp.totalBatches, totalSerials: resp.totalSerials, serialsActivated },
      200, true, null, batches.length, serialsActivated);
    return res.json(resp);
  } catch (err: any) {
    logApiCall("/batches/export", "GET", { from, to }, { error: err.message }, 500, false, err.message, 0, 0);
    return res.status(500).json({ error: err.message });
  }
}

// ─── DOWNLOAD EXCEL ───

async function downloadBatches(res: VercelResponse) {
  const [batches, serials] = await Promise.all([
    pool.query(`
      SELECT b.*, COALESCE(s.act, 0) as activated_count
      FROM batches b
      LEFT JOIN (SELECT batch_id, COUNT(*) as act FROM serial_numbers WHERE status='activated' GROUP BY batch_id) s ON s.batch_id = b.id
      ORDER BY b.created_at DESC
    `),
    pool.query(`
      SELECT s.serial_number, s.batch_code, s.sku_id, s.status, s.activated_at, s.created_at,
             b.role_number, b.production_date
      FROM serial_numbers s JOIN batches b ON s.batch_id = b.id
      ORDER BY s.batch_code, s.serial_number
    `),
  ]);

  const batchRows = batches.rows.map((b: any) => ({
    "Batch Code": b.batch_code, "SKU ID": b.sku_id, "Prefix": b.prefix,
    "Start Number": b.start_number, "End Number": b.end_number,
    "Quantity": b.quantity, "Activated": parseInt(b.activated_count) || 0,
    "Role Number": b.role_number || "", "Production Date": b.production_date,
    "Status": b.status,
    "Created At": b.created_at ? new Date(b.created_at).toISOString().replace("T", " ").substring(0, 19) : "",
  }));

  const serialRows = serials.rows.map((s: any) => ({
    "Serial Number": s.serial_number, "Batch Code": s.batch_code, "SKU ID": s.sku_id,
    "Role Number": s.role_number || "", "Production Date": s.production_date, "Status": s.status,
    "Activated At": s.activated_at ? new Date(s.activated_at).toISOString().replace("T", " ").substring(0, 19) : "",
    "Created At": s.created_at ? new Date(s.created_at).toISOString().replace("T", " ").substring(0, 19) : "",
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(batchRows), "Batches");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(serialRows), "Serial Numbers");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="batches_${new Date().toISOString().substring(0, 10)}.xlsx"`);
  return res.send(Buffer.from(buf));
}

// ─── API LOGS ───

function logApiCall(
  endpoint: string, method: string, requestParams: any, responseData: any,
  statusCode: number, success: boolean, errorMessage: string | null,
  batchesCount: number, serialsActivated: number
) {
  pool.query(
    `INSERT INTO api_logs (endpoint, method, request_params, response_data, status_code, success, error_message, batches_count, serials_activated)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [endpoint, method, JSON.stringify(requestParams), JSON.stringify(responseData), statusCode, success, errorMessage, batchesCount, serialsActivated]
  ).catch(() => {});
}

async function getApiLogs(req: VercelRequest, res: VercelResponse) {
  const query = getQuery(req.url || "");
  const page = parseInt(query.get("page") || "1");
  const limit = parseInt(query.get("limit") || "50");
  const offset = (page - 1) * limit;

  const [logs, countResult] = await Promise.all([
    pool.query(`SELECT * FROM api_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]),
    pool.query("SELECT COUNT(*) as total FROM api_logs"),
  ]);

  return res.json({ logs: logs.rows, total: parseInt(countResult.rows[0].total), page, limit, totalPages: Math.ceil(parseInt(countResult.rows[0].total) / limit) });
}

// ─── SETTINGS ───

async function getSettings(res: VercelResponse) {
  const result = await pool.query("SELECT key, value FROM settings");
  const settings: Record<string, string> = {};
  for (const row of result.rows) settings[row.key] = row.value;
  return res.json(settings);
}

async function updateSettings(req: VercelRequest, res: VercelResponse) {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "Key is required" });
  await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`, [key, value || ""]);
  return res.json({ message: "Setting saved", key, value });
}
