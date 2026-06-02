/**
 * Trading Bot — Railway Server
 * - Serves the dashboard at /
 * - Accepts trade/audit data from the local bot via POST /ingest
 * - Reads from Railway Postgres
 * - Provides API endpoints for the dashboard
 *
 * Env vars (set in Railway dashboard):
 *   DATABASE_URL  — auto-set by Railway Postgres plugin
 *   INGEST_SECRET — a secret string you choose, bot must send this header
 *   PORT          — auto-set by Railway
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const PORT = process.env.PORT || 3001;
const INGEST_SECRET = process.env.INGEST_SECRET || "change-me";
const DATABASE_URL = process.env.DATABASE_URL || "";

// ─── DATABASE ─────────────────────────────────────────────────────────────────
let db = null;

async function getDb() {
  if (db) return db;
  db = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();
  await db.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      symbol TEXT,
      side TEXT,
      qty TEXT,
      order_type TEXT,
      limit_price TEXT,
      stop_loss_price TEXT,
      take_profit_price TEXT,
      rationale TEXT,
      order_id TEXT,
      status TEXT,
      pnl FLOAT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      tool TEXT,
      symbol TEXT,
      blocked BOOLEAN DEFAULT FALSE,
      result TEXT
    );
    CREATE TABLE IF NOT EXISTS nav_history (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      equity FLOAT,
      cash FLOAT,
      day_pnl FLOAT
    );
    CREATE TABLE IF NOT EXISTS halt_events (
      id SERIAL PRIMARY KEY,
      ts TIMESTAMPTZ DEFAULT NOW(),
      halted BOOLEAN
    );
  `);
  return db;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function json(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function serveFile(res, filePath, contentType) {
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// ─── SERVER ───────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,OPTIONS", "Access-Control-Allow-Headers": "Content-Type,x-ingest-secret" });
    res.end(); return;
  }

  // ── Dashboard (static files) ──────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/") {
    serveFile(res, path.join(__dirname, "dashboard/index.html"), "text/html"); return;
  }
  if (req.method === "GET" && url.pathname === "/config.js") {
    // Inject Railway env vars into config.js at runtime
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(`window.RAILWAY_API = '${process.env.RAILWAY_PUBLIC_DOMAIN ? "https://" + process.env.RAILWAY_PUBLIC_DOMAIN : ""}';`);
    return;
  }

  // ── Dashboard API endpoints ───────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/trades") {
    try {
      const client = await getDb();
      const r = await client.query("SELECT * FROM trades ORDER BY ts DESC LIMIT 50");
      json(res, 200, r.rows);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/audit") {
    try {
      const client = await getDb();
      const r = await client.query("SELECT * FROM audit_log ORDER BY ts DESC LIMIT 50");
      json(res, 200, r.rows);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/nav") {
    try {
      const client = await getDb();
      const r = await client.query("SELECT * FROM nav_history ORDER BY ts DESC LIMIT 100");
      json(res, 200, r.rows);
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/halt-status") {
    try {
      const client = await getDb();
      const r = await client.query("SELECT halted FROM halt_events ORDER BY ts DESC LIMIT 1");
      json(res, 200, { halted: r.rows[0]?.halted || false });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  // ── Ingest endpoint (bot POSTs data here) ─────────────────────────────────
  if (req.method === "POST" && url.pathname === "/ingest") {
    if (req.headers["x-ingest-secret"] !== INGEST_SECRET) {
      json(res, 401, { error: "unauthorized" }); return;
    }
    const body = await parseBody(req);
    try {
      const client = await getDb();
      const { type, data } = body;

      if (type === "trade") {
        await client.query(
          `INSERT INTO trades (ts, symbol, side, qty, order_type, limit_price, stop_loss_price, take_profit_price, rationale, order_id, status, pnl)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [data.ts||new Date(), data.symbol, data.side, data.qty, data.order_type, data.limit_price, data.stop_loss_price, data.take_profit_price, data.rationale, data.order_id, data.status, data.pnl||0]
        );
      } else if (type === "audit") {
        await client.query(
          `INSERT INTO audit_log (ts, tool, symbol, blocked, result) VALUES ($1,$2,$3,$4,$5)`,
          [data.ts||new Date(), data.tool, data.symbol||null, data.blocked||false, data.result||"ok"]
        );
      } else if (type === "nav") {
        await client.query(
          `INSERT INTO nav_history (ts, equity, cash, day_pnl) VALUES ($1,$2,$3,$4)`,
          [data.ts||new Date(), data.equity, data.cash, data.day_pnl||0]
        );
      } else if (type === "halt") {
        await client.query(
          `INSERT INTO halt_events (ts, halted) VALUES ($1,$2)`,
          [new Date(), data.halted]
        );
      }
      json(res, 200, { ok: true });
    } catch (e) { json(res, 500, { error: e.message }); }
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`Railway server running on port ${PORT}`);
  getDb().then(() => console.log("Database connected and tables ready")).catch(e => console.error("DB error:", e.message));
});
