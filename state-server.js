/**
 * Tiny local HTTP server that reads state/*.jsonl files
 * and serves them to the dashboard on port 3001.
 * Run: node state-server.js
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

const STATE_DIR = path.join(__dirname, "state");
const HALT_FILE = process.env.HALT_FILE || path.join(os.tmpdir(), "HALT_TRADING");
const PORT = 3001;

function readJsonl(file) {
  try {
    return fs.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(l => JSON.parse(l));
  } catch { return []; }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "POST" && req.url === "/halt") {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      try {
        const { halted } = JSON.parse(body);
        if (halted) {
          fs.writeFileSync(HALT_FILE, new Date().toISOString());
          console.log("HALT_TRADING file created at", HALT_FILE);
        } else {
          if (fs.existsSync(HALT_FILE)) fs.unlinkSync(HALT_FILE);
          console.log("HALT_TRADING file removed");
        }
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, halted }));
      } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "bad request" }));
      }
    });
    return;
  }

  if (req.url === "/trades") {
    const trades = readJsonl(path.join(STATE_DIR, "trades.jsonl"));
    res.writeHead(200);
    res.end(JSON.stringify(trades));
    return;
  }

  if (req.url === "/audit") {
    const audit = readJsonl(path.join(STATE_DIR, "audit.jsonl"));
    res.writeHead(200);
    res.end(JSON.stringify(audit));
    return;
  }

  if (req.url === "/nav") {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(STATE_DIR, "daily_pnl.json"), "utf8"));
      res.writeHead(200);
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "no nav data yet" }));
    }
    return;
  }

  if (req.url === "/halt-status") {
    res.writeHead(200);
    res.end(JSON.stringify({ halted: fs.existsSync(HALT_FILE) }));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

server.listen(PORT, () => {
  console.log(`State server running at http://localhost:${PORT}`);
  console.log(`Halt file path: ${HALT_FILE}`);
  console.log(`State directory: ${STATE_DIR}`);
});
