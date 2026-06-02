#!/usr/bin/env node
/**
 * UPSTOX MCP SERVER — Indian Stock Market
 * Translates Claude Code tool calls → Upstox V2 REST API
 * Every WRITE tool passes through the Risk Gate before hitting Upstox.
 * All calls are logged to ../state/audit_in.jsonl
 *
 * Env vars (set in ~/.claude/mcp.json):
 *   UPSTOX_ACCESS_TOKEN  — daily OAuth token (see get-token.js to generate)
 *   UPSTOX_API_KEY       — your Upstox app API key
 *   UPSTOX_SANDBOX=true  — set false for live trading
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const os = require("os");

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const SANDBOX = process.env.UPSTOX_SANDBOX !== "false";
const BASE_HOST = SANDBOX ? "api-sandbox.upstox.com" : "api.upstox.com";
const ACCESS_TOKEN = process.env.UPSTOX_ACCESS_TOKEN || "";
const STATE_DIR = path.resolve(__dirname, "../state");
const AUDIT_LOG = path.join(STATE_DIR, "audit_in.jsonl");
const HALT_FILE = process.env.HALT_FILE || path.join(os.tmpdir(), "HALT_TRADING");
const TOKEN_FILE = path.join(STATE_DIR, "upstox_token.json");

// ─── INSTRUMENT KEY MAP ───────────────────────────────────────────────────────
// Upstox uses instrument keys like "NSE_EQ|INE002A01018"
// Add more symbols here as needed
const INSTRUMENT_KEYS = {
  "RELIANCE":  "NSE_EQ|INE002A01018",
  "TCS":       "NSE_EQ|INE467B01029",
  "HDFCBANK":  "NSE_EQ|INE040A01034",
  "INFY":      "NSE_EQ|INE009A01021",
  "ICICIBANK": "NSE_EQ|INE090A01021",
  "NIFTYBEES": "NSE_EQ|INE732E01003",
  "NIFTY50":   "NSE_INDEX|Nifty 50",
  "BANKNIFTY": "NSE_INDEX|Nifty Bank",
};

function getInstrumentKey(symbol) {
  return INSTRUMENT_KEYS[symbol.toUpperCase()] || symbol;
}

const RISK = {
  dailyLossCapPct: 0.05,
  notionalCapPct: 0.30,
  maxConcurrentPositions: 4,
};

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function audit(tool, input, result, blocked = false) {
  ensureStateDir();
  const entry = { ts: new Date().toISOString(), tool, input, blocked, result: blocked ? result : "ok" };
  fs.appendFileSync(AUDIT_LOG, JSON.stringify(entry) + "\n");
}

function getToken() {
  // Prefer env var, fallback to state file
  if (ACCESS_TOKEN) return ACCESS_TOKEN;
  try {
    const t = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    return t.access_token || "";
  } catch { return ""; }
}

function upstoxRequest(method, endpoint, params = null, body = null) {
  return new Promise((resolve, reject) => {
    const token = getToken();
    if (!token) {
      reject(new Error("No Upstox access token. Run get-token.js to authenticate."));
      return;
    }

    const headers = {
      "Authorization": "Bearer " + token,
      "Content-Type": "application/json",
      "Accept": "application/json",
      "Api-Version": "2.0",
    };

    let urlPath = "/v2" + endpoint;
    if (params && Object.keys(params).length) {
      urlPath += "?" + new URLSearchParams(params).toString();
    }

    const options = { hostname: BASE_HOST, path: urlPath, method, headers };
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

// ─── MARKET HOURS (IST) ───────────────────────────────────────────────────────
function isMarketHours() {
  // IST = UTC+5:30
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const day = ist.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const mins = h * 60 + m;
  return mins >= 555 && mins <= 930; // 9:15 AM to 3:30 PM IST
}

// ─── RISK GATE ────────────────────────────────────────────────────────────────
async function riskGate(tool, params) {
  if (fs.existsSync(HALT_FILE)) {
    return { blocked: true, reason: "KILL_SWITCH: HALT_TRADING file exists" };
  }

  if (tool === "place_order" && !isMarketHours()) {
    return { blocked: true, reason: "MARKET_CLOSED: NSE/BSE hours are 9:15 AM – 3:30 PM IST (Mon–Fri)" };
  }

  try {
    const stateFile = path.join(STATE_DIR, "daily_pnl_in.json");
    if (fs.existsSync(stateFile)) {
      const { pnlPct } = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      if (pnlPct <= -RISK.dailyLossCapPct && tool !== "cancel_order" && tool !== "close_position") {
        return { blocked: true, reason: `DAILY_LOSS_CAP: PnL ${(pnlPct * 100).toFixed(2)}% ≤ -5%` };
      }
    }
  } catch {}

  if (tool === "place_order") {
    try {
      const funds = await upstoxRequest("GET", "/user/fund-and-margin", { segment: "SEC" });
      const nav = parseFloat(funds?.data?.equity?.available_margin || "0");
      if (params.price && params.quantity) {
        const notional = parseFloat(params.price) * parseInt(params.quantity);
        if (nav > 0 && notional / nav > RISK.notionalCapPct) {
          return { blocked: true, reason: `NOTIONAL_CAP: ₹${notional.toFixed(0)} > 30% of margin ₹${nav.toFixed(0)}` };
        }
      }
    } catch {}

    try {
      const pos = await upstoxRequest("GET", "/portfolio/positions");
      const open = (pos?.data || []).filter(p => p.quantity !== 0);
      if (open.length >= RISK.maxConcurrentPositions) {
        return { blocked: true, reason: `CONCURRENT_CAP: ${open.length} open positions (max ${RISK.maxConcurrentPositions})` };
      }
    } catch {}
  }

  return { blocked: false };
}

// ─── TOOL DEFINITIONS ─────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "in_get_candles",
    description: "Get historical OHLCV candles for an Indian stock (NSE/BSE)",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK, NIFTYBEES" },
        interval: { type: "string", description: "1minute, 30minute, day, week, month" },
        from_date: { type: "string", description: "YYYY-MM-DD" },
        to_date: { type: "string", description: "YYYY-MM-DD (default today)" },
      },
      required: ["symbol", "interval"],
    },
  },
  {
    name: "in_get_quote",
    description: "Get live market quote (LTP, OHLC, volume) for Indian stocks",
    inputSchema: {
      type: "object",
      properties: {
        symbols: { type: "array", items: { type: "string" }, description: "e.g. ['RELIANCE','TCS']" },
      },
      required: ["symbols"],
    },
  },
  {
    name: "in_get_funds",
    description: "Get available margin/funds in your Upstox account",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "in_get_positions",
    description: "Get all open intraday and delivery positions",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "in_get_holdings",
    description: "Get long-term delivery holdings (CNC)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "in_get_orders",
    description: "Get today's order book",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "in_place_order",
    description: "Place an order on NSE/BSE. WRITE — passes through risk gate.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "e.g. RELIANCE, TCS, HDFCBANK" },
        transaction_type: { type: "string", enum: ["BUY", "SELL"] },
        quantity: { type: "number", description: "Number of shares" },
        order_type: { type: "string", enum: ["MARKET", "LIMIT", "SL", "SL-M"] },
        product: { type: "string", enum: ["I", "D"], description: "I=intraday MIS, D=delivery CNC" },
        price: { type: "number", description: "Limit price (required for LIMIT/SL orders)" },
        trigger_price: { type: "number", description: "Trigger price for SL/SL-M orders" },
        stop_loss_price: { type: "number", description: "Stop loss price for risk logging" },
        take_profit_price: { type: "number", description: "Take profit price for risk logging" },
        rationale: { type: "string", description: "Claude's reasoning for this trade" },
      },
      required: ["symbol", "transaction_type", "quantity", "order_type", "product"],
    },
  },
  {
    name: "in_cancel_order",
    description: "Cancel an open order by order ID",
    inputSchema: {
      type: "object",
      properties: { order_id: { type: "string" } },
      required: ["order_id"],
    },
  },
  {
    name: "in_close_position",
    description: "Square off (close) an open intraday position",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        quantity: { type: "number", description: "Shares to close. 0 = full position." },
      },
      required: ["symbol"],
    },
  },
  {
    name: "in_market_status",
    description: "Check if NSE market is currently open (9:15 AM – 3:30 PM IST, Mon–Fri)",
    inputSchema: { type: "object", properties: {} },
  },
];

// ─── TOOL HANDLERS ────────────────────────────────────────────────────────────
async function handleTool(name, input) {
  switch (name) {
    case "in_get_candles": {
      const key = encodeURIComponent(getInstrumentKey(input.symbol));
      const to = input.to_date || new Date().toISOString().split("T")[0];
      const from = input.from_date || (() => {
        const d = new Date(); d.setDate(d.getDate() - 30);
        return d.toISOString().split("T")[0];
      })();
      const res = await upstoxRequest("GET", `/historical-candle/${key}/${input.interval}/${to}/${from}`);
      return res?.data?.candles || res;
    }
    case "in_get_quote": {
      const keys = input.symbols.map(s => getInstrumentKey(s)).join(",");
      const res = await upstoxRequest("GET", "/market-quote/quotes", { instrument_key: keys });
      return res?.data || res;
    }
    case "in_get_funds": {
      const res = await upstoxRequest("GET", "/user/fund-and-margin", { segment: "SEC" });
      return res?.data || res;
    }
    case "in_get_positions": {
      const res = await upstoxRequest("GET", "/portfolio/positions");
      return res?.data || res;
    }
    case "in_get_holdings": {
      const res = await upstoxRequest("GET", "/portfolio/holdings");
      return res?.data || res;
    }
    case "in_get_orders": {
      const res = await upstoxRequest("GET", "/orders");
      return res?.data || res;
    }
    case "in_place_order": {
      const gate = await riskGate("place_order", { price: input.price, quantity: input.quantity });
      if (gate.blocked) {
        audit("in_place_order", input, gate.reason, true);
        return { blocked: true, reason: gate.reason };
      }
      const body = {
        instrument_token: getInstrumentKey(input.symbol),
        transaction_type: input.transaction_type,
        quantity: input.quantity,
        order_type: input.order_type,
        product: input.product,
        validity: "DAY",
        price: input.price || 0,
        trigger_price: input.trigger_price || 0,
        disclosed_quantity: 0,
        is_amo: false,
      };
      const res = await upstoxRequest("POST", "/order/place", null, body);
      audit("in_place_order", { ...input }, res?.message || "ok");
      appendTradeState(input, res);
      return res;
    }
    case "in_cancel_order": {
      const res = await upstoxRequest("DELETE", "/order/cancel", { order_id: input.order_id });
      audit("in_cancel_order", input, res?.message || "ok");
      return res;
    }
    case "in_close_position": {
      // Get current position to determine side and quantity
      const posRes = await upstoxRequest("GET", "/portfolio/positions");
      const positions = posRes?.data || [];
      const pos = positions.find(p =>
        p.tradingsymbol === input.symbol.toUpperCase() && p.quantity !== 0
      );
      if (!pos) return { error: "No open position found for " + input.symbol };
      const qty = input.quantity || Math.abs(pos.quantity);
      const side = pos.quantity > 0 ? "SELL" : "BUY";
      const body = {
        instrument_token: getInstrumentKey(input.symbol),
        transaction_type: side,
        quantity: qty,
        order_type: "MARKET",
        product: pos.product || "I",
        validity: "DAY",
        price: 0,
        trigger_price: 0,
        disclosed_quantity: 0,
        is_amo: false,
      };
      const res = await upstoxRequest("POST", "/order/place", null, body);
      audit("in_close_position", input, res?.message || "ok");
      return res;
    }
    case "in_market_status": {
      const open = isMarketHours();
      const now = new Date();
      const istTime = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
      return {
        is_open: open,
        current_ist: istTime.toUTCString().replace("GMT", "IST"),
        market_hours: "9:15 AM – 3:30 PM IST, Monday–Friday",
        message: open ? "NSE market is OPEN" : "NSE market is CLOSED",
      };
    }
    default:
      return { error: "Unknown tool: " + name };
  }
}

function appendTradeState(input, res) {
  try {
    const tradeFile = path.join(STATE_DIR, "trades_in.jsonl");
    fs.appendFileSync(tradeFile, JSON.stringify({
      ts: new Date().toISOString(),
      symbol: input.symbol,
      side: input.transaction_type,
      quantity: input.quantity,
      order_type: input.order_type,
      product: input.product,
      price: input.price,
      stop_loss: input.stop_loss_price,
      take_profit: input.take_profit_price,
      rationale: input.rationale,
      order_id: res?.data?.order_id,
    }) + "\n");
  } catch {}
}

// ─── MCP JSON-RPC SERVER (stdio) ─────────────────────────────────────────────
const rl = readline.createInterface({ input: process.stdin });
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

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
        serverInfo: { name: "upstox-india-mcp", version: "1.0.0" },
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
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } });
    } catch (err) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true } });
    }
    return;
  }
  if (method === "notifications/initialized") return;
  send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: " + method } });
});
