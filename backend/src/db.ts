import path from "path";

const DATABASE_URL = process.env.DATABASE_URL;

// Convert ? placeholders to $1, $2, ... for PostgreSQL
function toPgParams(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Convert NOW() to datetime('now') for SQLite
function toSqliteTime(sql: string): string {
  return sql.replace(/NOW\(\)/gi, "datetime('now')");
}

// ─── SQLite implementation ───
function createSqliteDb() {
  const Database = require("better-sqlite3");
  const db = new Database(path.join(__dirname, "..", "plant_management.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return {
    async init() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_code TEXT NOT NULL,
          sku_id TEXT NOT NULL,
          prefix TEXT NOT NULL,
          start_number INTEGER NOT NULL,
          end_number INTEGER NOT NULL,
          quantity INTEGER NOT NULL,
          production_date TEXT NOT NULL,
          role_number TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          status TEXT NOT NULL DEFAULT 'created'
        );
        CREATE TABLE IF NOT EXISTS serial_numbers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          batch_id INTEGER NOT NULL,
          serial_number TEXT NOT NULL,
          batch_code TEXT NOT NULL,
          sku_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          activated_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (batch_id) REFERENCES batches(id)
        );
        CREATE INDEX IF NOT EXISTS idx_serial_number ON serial_numbers(serial_number);
        CREATE INDEX IF NOT EXISTS idx_batch_id ON serial_numbers(batch_id);
        CREATE INDEX IF NOT EXISTS idx_serial_status ON serial_numbers(status);

        CREATE TABLE IF NOT EXISTS api_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          endpoint TEXT NOT NULL,
          method TEXT NOT NULL,
          request_params TEXT,
          response_data TEXT,
          status_code INTEGER NOT NULL,
          success INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          batches_count INTEGER DEFAULT 0,
          serials_activated INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },

    async query(sql: string, params: any[] = []): Promise<any[]> {
      return db.prepare(toSqliteTime(sql)).all(...params);
    },

    async queryOne(sql: string, params: any[] = []): Promise<any | null> {
      return db.prepare(toSqliteTime(sql)).get(...params) || null;
    },

    async execute(sql: string, params: any[] = []): Promise<{ lastId: number }> {
      const result = db.prepare(toSqliteTime(sql)).run(...params);
      return { lastId: Number(result.lastInsertRowid) };
    },

    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const sqliteTx = {
        async query(sql: string, params: any[] = []) {
          return db.prepare(toSqliteTime(sql)).all(...params);
        },
        async queryOne(sql: string, params: any[] = []) {
          return db.prepare(toSqliteTime(sql)).get(...params) || null;
        },
        async execute(sql: string, params: any[] = []) {
          const result = db.prepare(toSqliteTime(sql)).run(...params);
          return { lastId: Number(result.lastInsertRowid) };
        },
      };
      const begin = db.prepare("BEGIN");
      const commit = db.prepare("COMMIT");
      const rollback = db.prepare("ROLLBACK");
      begin.run();
      try {
        const result = await fn(sqliteTx);
        commit.run();
        return result;
      } catch (e) {
        rollback.run();
        throw e;
      }
    },
  };
}

// ─── PostgreSQL implementation ───
function createPgDb() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  return {
    async init() {
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
          serial_number TEXT NOT NULL,
          batch_code TEXT NOT NULL,
          sku_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          activated_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
      `);
      // Create indexes (IF NOT EXISTS for indexes requires PostgreSQL 9.5+)
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_serial_number ON serial_numbers(serial_number)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_batch_id ON serial_numbers(batch_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_serial_status ON serial_numbers(status)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS api_logs (
          id SERIAL PRIMARY KEY,
          endpoint TEXT NOT NULL,
          method TEXT NOT NULL,
          request_params JSONB,
          response_data JSONB,
          status_code INTEGER NOT NULL,
          success BOOLEAN NOT NULL DEFAULT false,
          error_message TEXT,
          batches_count INTEGER DEFAULT 0,
          serials_activated INTEGER DEFAULT 0,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_api_logs_created_at ON api_logs(created_at);

        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },

    async query(sql: string, params: any[] = []): Promise<any[]> {
      const result = await pool.query(toPgParams(sql), params);
      return result.rows;
    },

    async queryOne(sql: string, params: any[] = []): Promise<any | null> {
      const result = await pool.query(toPgParams(sql), params);
      return result.rows[0] || null;
    },

    async execute(sql: string, params: any[] = []): Promise<{ lastId: number }> {
      // Append RETURNING id if it's an INSERT and doesn't already have RETURNING
      let finalSql = toPgParams(sql);
      if (/^\s*INSERT/i.test(finalSql) && !/RETURNING/i.test(finalSql)) {
        finalSql += " RETURNING id";
      }
      const result = await pool.query(finalSql, params);
      return { lastId: result.rows[0]?.id || 0 };
    },

    async transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const tx = {
          async query(sql: string, params: any[] = []) {
            const result = await client.query(toPgParams(sql), params);
            return result.rows;
          },
          async queryOne(sql: string, params: any[] = []) {
            const result = await client.query(toPgParams(sql), params);
            return result.rows[0] || null;
          },
          async execute(sql: string, params: any[] = []) {
            let finalSql = toPgParams(sql);
            if (/^\s*INSERT/i.test(finalSql) && !/RETURNING/i.test(finalSql)) {
              finalSql += " RETURNING id";
            }
            const result = await client.query(finalSql, params);
            return { lastId: result.rows[0]?.id || 0 };
          },
        };
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

export type DB = ReturnType<typeof createSqliteDb>;

const db: DB = DATABASE_URL ? createPgDb() : createSqliteDb();
export default db;
