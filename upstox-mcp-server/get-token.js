/**
 * Upstox Daily Token Generator
 * Run: node get-token.js
 *
 * This opens the Upstox login URL in your browser.
 * After login, paste the `code` from the redirect URL here.
 * The access token is saved to ../state/upstox_token.json
 */

const https = require("https");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const API_KEY = process.env.UPSTOX_API_KEY || "";
const API_SECRET = process.env.UPSTOX_API_SECRET || "";
const REDIRECT_URI = process.env.UPSTOX_REDIRECT_URI || "http://localhost";
const STATE_DIR = path.resolve(__dirname, "../state");
const TOKEN_FILE = path.join(STATE_DIR, "upstox_token.json");

if (!API_KEY || !API_SECRET) {
  console.error("ERROR: Set UPSTOX_API_KEY and UPSTOX_API_SECRET environment variables first.");
  process.exit(1);
}

const authUrl = `https://api.upstox.com/v2/login/authorization/dialog?client_id=${API_KEY}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;

console.log("\n=== Upstox Daily Token Generator ===\n");
console.log("1. Open this URL in your browser:");
console.log("\n" + authUrl + "\n");
console.log("2. Log in with your Upstox credentials");
console.log("3. After login, you'll be redirected to a URL like:");
console.log("   http://localhost/?code=XXXXXXXXXX");
console.log("4. Copy the `code` value and paste it below.\n");

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question("Paste the authorization code: ", (code) => {
  rl.close();
  code = code.trim();

  const body = new URLSearchParams({
    code,
    client_id: API_KEY,
    client_secret: API_SECRET,
    redirect_uri: REDIRECT_URI,
    grant_type: "authorization_code",
  }).toString();

  const options = {
    hostname: "api.upstox.com",
    path: "/v2/login/authorization/token",
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
  };

  const req = https.request(options, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const token = JSON.parse(data);
        if (token.access_token) {
          if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
          fs.writeFileSync(TOKEN_FILE, JSON.stringify({ ...token, saved_at: new Date().toISOString() }, null, 2));
          console.log("\n✅ Token saved to", TOKEN_FILE);
          console.log("   Access token:", token.access_token.slice(0, 20) + "...");
          console.log("   Valid for: 1 day (run this again tomorrow)\n");
          console.log("Now restart Claude Code to use the new token.");
        } else {
          console.error("\n❌ Failed to get token:", data);
        }
      } catch (e) {
        console.error("Parse error:", e.message, data);
      }
    });
  });
  req.on("error", console.error);
  req.write(body);
  req.end();
});
