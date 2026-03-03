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
  const { startSerial, endSerial, batchCode, skuId, productionDate } = req.body;

  if (!startSerial || !endSerial || !batchCode || !skuId || !productionDate) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const startMatch = startSerial.match(/^([A-Za-z])(\d+)$/);
  const endMatch = endSerial.match(/^([A-Za-z])(\d+)$/);

  if (!startMatch || !endMatch) {
    return res.status(400).json({ error: "Invalid serial number format. Use 1 letter (A-Z) + digits (e.g., A1, A100000)" });
  }

  const prefix = startMatch[1].toUpperCase();
  const endPrefix = endMatch[1].toUpperCase();

  if (prefix !== endPrefix) {
    return res.status(400).json({ error: "Start and end serial numbers must have the same prefix" });
  }

  const startNum = parseInt(startMatch[2], 10);
  const endNum = parseInt(endMatch[2], 10);

  if (endNum <= startNum) {
    return res.status(400).json({ error: "End serial number must be greater than start serial number" });
  }

  const quantity = endNum - startNum;
  const numWidth = Math.max(startMatch[2].length, endMatch[2].length);

  const firstSerial = `${prefix}${String(startNum + 1).padStart(numWidth, "0")}`;
  const lastSerial = `${prefix}${String(endNum).padStart(numWidth, "0")}`;

  const existing = await pool.query(
    pg("SELECT COUNT(*) as count FROM serial_numbers WHERE serial_number BETWEEN ? AND ?"),
    [firstSerial, lastSerial]
  );

  if (parseInt(existing.rows[0].count) > 0) {
    return res.status(400).json({ error: "Some serial numbers in this range already exist in the database" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const batchResult = await client.query(
      pg("INSERT INTO batches (batch_code, sku_id, prefix, start_number, end_number, quantity, production_date) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id"),
      [batchCode, skuId, prefix, startNum, endNum, quantity, productionDate]
    );
    const batchId = batchResult.rows[0].id;

    for (let i = startNum + 1; i <= endNum; i++) {
      const serialNumber = `${prefix}${String(i).padStart(numWidth, "0")}`;
      await client.query(
        pg("INSERT INTO serial_numbers (batch_id, serial_number, batch_code, sku_id) VALUES (?, ?, ?, ?)"),
        [batchId, serialNumber, batchCode, skuId]
      );
    }

    await client.query("COMMIT");

    const batch = await pool.query(pg("SELECT * FROM batches WHERE id = ?"), [batchId]);
    return res.status(201).json({ message: "Batch created successfully", batch: batch.rows[0] });
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

async function deleteBatch(_req: VercelRequest, res: VercelResponse, id: number) {
  const batch = await pool.query(pg("SELECT * FROM batches WHERE id = ?"), [id]);
  if (batch.rows.length === 0) {
    return res.status(404).json({ error: "Batch not found" });
  }

  await pool.query(pg("DELETE FROM serial_numbers WHERE batch_id = ?"), [id]);
  await pool.query(pg("DELETE FROM batches WHERE id = ?"), [id]);

  return res.json({ message: "Batch deleted successfully" });
}
