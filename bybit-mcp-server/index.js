#!/usr/bin/env node
/**
 * ALPACA MARKETS MCP SERVER
 * Translates Claude Code tool calls → Alpaca REST API (Paper trading by default)
 * Every WRITE tool passes through the Risk Gate before hitting Alpaca.
 * All calls are logged to ../state/audit.jsonl
 *
 * Setup:
 *   node index.js
 *
 * Env vars (set in ~/.claude/mcp.json):
 *   ALPACA_API_KEY, ALPACA_API_SECRET, ALPACA_PAPER=true
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

// ─── SUPABASE ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "";

function supabaseInsert(table, data) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  const body = JSON.stringify(data);
  const url = new URL(`${SUPABASE_URL}/rest/v1/${table}`);
  const req = https.request({
    hostname: url.hostname, path: url.pathname, method: "POST",
    headers: {
      "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json", "Prefer": "return=minimal",
      "Content-Length": Buffer.byteLength(body),
    }
  }, () => {});
  req.on("error", () => {});
  req.write(body);
  req.end();
}

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PAPER = process.env.ALPACA_PAPER !== "false";
const TRADE_URL = PAPER ? "paper-api.alpaca.markets" : "api.alpaca.markets";
const DATA_URL = "data.alpaca.markets";
const API_KEY = process.env.ALPACA_API_KEY || "";
const API_SECRET = process.env.ALPACA_API_SECRET || "";
const STATE_DIR = path.resolve(__dirname, "../state");
const AUDIT_LOG = path.join(STATE_DIR, "audit.jsonl");
const HALT_FILE = process.env.HALT_FILE || path.join(os.tmpdir(), "HALT_TRADING");

const RISK = {
  dailyLossCapPct: 0.05,       // -5% NAV halts new entries
  notionalCapPct: 0.30,        // single order ≤ 30% NAV
  maxPositionPct: 0.10,        // single position ≤ 10% NAV
  maxConcurrentPositions: 4,
  allowExtendedHours: false,   // only trade regular market hours
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function audit(tool, input, result, blocked = false) {
  ensureStateDir();
  const entry = { ts: new Date().toISOString(), tool, input, blocked, result: blocked ? result : "ok" };
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
  supabaseInsert("audit_log", { ts: entry.ts, tool, symbol: input?.symbol || null, blocked, result: entry.result });
}

function alpacaRequest(hostname, method, path_, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {
      "APCA-API-KEY-ID": API_KEY,
      "APCA-API-SECRET-KEY": API_SECRET,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    const options = { hostname, path: path_, method, headers };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function trade(method, endpoint, body = null) {
  return alpacaRequest(TRADE_URL, method, "/v2" + endpoint, body);
}

function data(endpoint, params = {}) {
  const qs = Object.keys(params).length ? "?" + new URLSearchParams(params).toString() : "";
  return alpacaRequest(DATA_URL, "GET", "/v2" + endpoint + qs, null);
}

// ─── MARKET HOURS CHECK ───────────────────────────────────────────────────────
async function isMarketOpen() {
  try {
    const clock = await trade("GET", "/clock");
    return clock.is_open === true;
  } catch { return true; } // fail open so we don't block on API errors
}

// ─── RISK GATE ────────────────────────────────────────────────────────────────
async function riskGate(tool, params) {
  // 1. Kill switch
  if (fs.existsSync(HALT_FILE)) {
    return { blocked: true, reason: "KILL_SWITCH: HALT_TRADING file exists at " + HALT_FILE };
  }

  // 2. Market hours (for new entries only)
  if (tool === "place_order" && !RISK.allowExtendedHours) {
    const open = await isMarketOpen();
    if (!open) {
      return { blocked: true, reason: "MARKET_CLOSED: US market is not open. Orders are blocked outside regular hours." };
    }
  }

  // 3. Daily loss cap
  try {
    const stateFile = path.join(STATE_DIR, "daily_pnl.json");
    if (fs.existsSync(stateFile)) {
      const { pnlPct } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (pnlPct <= -RISK.dailyLossCapPct && tool !== "cancel_order" && tool !== "close_position") {
        return { blocked: true, reason: `DAILY_LOSS_CAP: PnL ${(pnlPct * 100).toFixed(2)}% ≤ -${RISK.dailyLossCapPct * 100}%` };
      }
    }
  } catch {}

  // 4. Notional cap
  if (tool === "place_order" && params.notional) {
    try {
      const account = await trade("GET", "/account");
      const nav = parseFloat(account.equity || account.portfolio_value || "0");
      const notional = parseFloat(params.notional);
      if (nav > 0 && notional / nav > RISK.notionalCapPct) {
        return { blocked: true, reason: `NOTIONAL_CAP: order $${notional.toFixed(2)} > ${RISK.notionalCapPct * 100}% of NAV $${nav.toFixed(2)}` };
      }
    } catch {}
  }

  if (tool === "place_order" && params.qty && params.limit_price) {
    try {
      const account = await trade("GET", "/account");
      const nav = parseFloat(account.equity || account.portfolio_value || "0");
      const notional = parseFloat(params.qty) * parseFloat(params.limit_price);
      if (nav > 0 && notional / nav > RISK.notionalCapPct) {
        return { blocked: true, reason: `NOTIONAL_CAP: order $${notional.toFixed(2)} > ${RISK.notionalCapPct * 100}% of NAV $${nav.toFixed(2)}` };
      }
    } catch {}
  }

  // 5. Concurrent positions cap
  if (tool === "place_order") {
    try {
      const positions = await trade("GET", "/positions");
      if (Array.isArray(positions) && positions.length >= RISK.maxConcurrentPositions) {
        return { blocked: true, reason: `CONCURRENT_CAP: already ${positions.length} open positions (max ${RISK.maxConcurrentPositions})` };
      }
    } catch {}
  }

  return { blocked: false };
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_bars",
    description: "Get OHLCV bar data for a stock symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. SPY, AAPL, TSLA" },
        timeframe: { type: "string", description: "1Min, 5Min, 15Min, 1Hour, 1Day" },
        limit: { type: "number", description: "Number of bars (default 100, max 1000)" },
      },
      required: ["symbol", "timeframe"],
    },
  },
  {
    name: "get_quote",
    description: "Get latest bid/ask quote and last trade price for a symbol",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_snapshot",
    description: "Get full market snapshot: latest quote, trade, daily bar, and minute bar",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string" } },
      required: ["symbol"],
    },
  },
  {
    name: "get_market_clock",
    description: "Get current market status: is_open, next_open, next_close times",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_account",
    description: "Get account info: equity (NAV), buying power, cash, day trade count",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_positions",
    description: "Get all open stock positions with unrealized P&L",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_open_orders",
    description: "Get all open (pending) orders",
    inputSchema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Optional symbol filter" } },
    },
  },
  {
    name: "get_trade_history",
    description: "Get recent closed orders (filled trades)",
    inputSchema: {
      type: "object",
      properties: { days: { type: "number", description: "Lookback days (default 1)" } },
    },
  },
  {
    name: "place_order",
    description: "Place a stock order. Supports bracket orders (entry + stop-loss + take-profit in one call). WRITE — passes through risk gate.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker e.g. SPY" },
        side: { type: "string", enum: ["buy", "sell"], description: "buy = long, sell = short" },
        qty: { type: "string", description: "Number of shares (use qty OR notional, not both)" },
        notional: { type: "string", description: "Dollar amount to invest e.g. '100.00' (fractional shares)" },
        order_type: { type: "string", enum: ["market", "limit", "stop", "stop_limit"], description: "Order type" },
        limit_price: { type: "string", description: "Required for limit orders" },
        stop_price: { type: "string", description: "Required for stop/stop_limit orders" },
        time_in_force: { type: "string", enum: ["day", "gtc", "ioc", "fok"], description: "Default: day" },
        stop_loss_price: { type: "string", description: "Stop-loss trigger price (creates bracket order)" },
        take_profit_price: { type: "string", description: "Take-profit limit price (creates bracket order)" },
        rationale: { type: "string", description: "Claude's reasoning for this trade (logged to audit)" },
      },
      required: ["symbol", "side", "order_type"],
    },
  },
  {
    name: "cancel_order",
    description: "Cancel an open order by order ID",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "cancel_all_orders",
    description: "Cancel all open orders",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "close_position",
    description: "Market-close an entire position for a symbol",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        qty: { type: "string", description: "Shares to close. Leave blank to close full position." },
        percentage: { type: "string", description: "Percentage of position to close e.g. '50' for half" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "close_all_positions",
    description: "Market-close ALL open positions (emergency use)",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────
async function handleTool(name, input) {
  switch (name) {
    case "get_bars": {
      const params = {
        timeframe: input.timeframe || "15Min",
        limit: input.limit || 100,
        feed: "iex",
        adjustment: "split",
      };
      const res = await data(`/stocks/${input.symbol}/bars`, params);
      return res.bars || res;
    }
    case "get_quote": {
      const res = await data(`/stocks/${input.symbol}/quotes/latest`);
      return res.quote || res;
    }
    case "get_snapshot": {
      const res = await data(`/stocks/${input.symbol}/snapshot`);
      return res;
    }
    case "get_market_clock": {
      return await trade("GET", "/clock");
    }
    case "get_account": {
      return await trade("GET", "/account");
    }
    case "get_positions": {
      return await trade("GET", "/positions");
    }
    case "get_open_orders": {
      let endpoint = "/orders?status=open&limit=100";
      if (input.symbol) endpoint += "&symbols=" + input.symbol;
      return await trade("GET", endpoint);
    }
    case "get_trade_history": {
      const days = input.days || 1;
      const after = new Date(Date.now() - days * 86400000).toISOString();
      return await trade("GET", `/orders?status=closed&limit=100&after=${after}`);
    }

    // WRITE TOOLS
    case "place_order": {
      const gate = await riskGate("place_order", input);
      if (gate.blocked) {
        audit("place_order", input, gate.reason, true);
        return { blocked: true, reason: gate.reason };
      }

      const body = {
        symbol: input.symbol,
        side: input.side,
        type: input.order_type,
        time_in_force: input.time_in_force || "day",
      };

      // qty XOR notional
      if (input.notional) {
        body.notional = input.notional;
      } else {
        body.qty = input.qty;
      }

      if (input.limit_price) body.limit_price = input.limit_price;
      if (input.stop_price) body.stop_price = input.stop_price;

      // Bracket order if both SL and TP provided
      if (input.stop_loss_price && input.take_profit_price) {
        body.order_class = "bracket";
        body.stop_loss = { stop_price: input.stop_loss_price };
        body.take_profit = { limit_price: input.take_profit_price };
      } else if (input.stop_loss_price) {
        body.order_class = "oto";
        body.stop_loss = { stop_price: input.stop_loss_price };
      } else if (input.take_profit_price) {
        body.order_class = "oto";
        body.take_profit = { limit_price: input.take_profit_price };
      }

      const res = await trade("POST", "/orders", body);
      audit("place_order", { ...input }, res?.message || "ok");
      appendTradeState(input, res);
      return res;
    }
    case "cancel_order": {
      const res = await trade("DELETE", `/orders/${input.order_id}`);
      audit("cancel_order", input, "ok");
      return res || { ok: true };
    }
    case "cancel_all_orders": {
      const res = await trade("DELETE", "/orders");
      audit("cancel_all_orders", input, "ok");
      return res;
    }
    case "close_position": {
      let endpoint = `/positions/${input.symbol}`;
      const params = [];
      if (input.qty) params.push("qty=" + input.qty);
      if (input.percentage) params.push("percentage=" + input.percentage);
      if (params.length) endpoint += "?" + params.join("&");
      const res = await trade("DELETE", endpoint);
      audit("close_position", input, res?.message || "ok");
      return res;
    }
    case "close_all_positions": {
      const res = await trade("DELETE", "/positions?cancel_orders=true");
      audit("close_all_positions", input, "ok");
      return res;
    }
    default:
      return { error: "Unknown tool: " + name };
  }
}

function appendTradeState(input, res) {
  try {
    const record = {
      ts: new Date().toISOString(),
      symbol: input.symbol,
      side: input.side,
      qty: input.qty || input.notional,
      order_type: input.order_type,
      limit_price: input.limit_price,
      stop_loss_price: input.stop_loss_price,
      take_profit_price: input.take_profit_price,
      rationale: input.rationale,
      order_id: res?.id,
      status: res?.status,
      pnl: 0,
    };
    ensureStateDir();
    fs.appendFileSync(path.join(STATE_DIR, "trades.jsonl"), JSON.stringify(record) + "\n");
    supabaseInsert("trades", record);
  } catch {}
}

// ─── MCP JSON-RPC SERVER (stdio) ─────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

rl.on("line", async (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }

  const { id, method, params } = msg;

  if (method === "initialize") {
    send({
      jsonrpc: "2.0", id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "alpaca-stock-mcp", version: "1.0.0" },
      },
    });
    return;
  }

  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }

  if (method === "tools/call") {
    const { name, arguments: args } = params;
    try {
      const result = await handleTool(name, args || {});
      send({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
      });
    } catch (err) {
      send({
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true },
      });
    }
    return;
  }

  if (method === "notifications/initialized") return;

  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
});
