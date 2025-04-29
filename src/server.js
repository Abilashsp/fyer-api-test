// server.js – resolution‑smart socket server using TradingStrategy.setResolution()

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");
const dotenv     = require("dotenv");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const tradingService = require("./tradingService");
const authManager    = require("./auth2.0");
const { connect: connectDataSocket } = require("./dataSocket");
const Strategy       = require("./strategy");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: "http://localhost:3000", methods: ["GET", "POST"], credentials: true }
});

app.use(cors());
app.use(express.json());

let strategy;                    // TradingStrategy instance
let currentResolution = "D";      // single source‑of‑truth timeframe

// ───────────────────────── socket hydration ─────────────────────────
io.on("connection", sock => {
  console.log("👋  UI connected");
  if (strategy) {
    sock.emit("initialBullishSignals", strategy.getBullishSignals());
    sock.emit("initialBearishSignals", strategy.getBearishSignals());
  }
});

// ───────────────────────── auth callback & health ───────────────────
app.get("/", (req, res) => {
  const code = req.query.auth_code;
  if (code) {
    authManager.setAuthCode(code);
    return res.send("<h1>Auth OK</h1>");
  }
  res.send("Server running");
});

// ───────────────────────── helper: normalize resolution ────────────
function normalise(res) {
  res = String(res).trim().toUpperCase();
  if (/^\d+M$/.test(res)) return res.slice(0, -1);          // "1M" → "1"
  if (/^\d+H$/.test(res)) return String(parseInt(res) * 60); // "2H" → "120"
  if (res === "1D") return "D";
  return res;
}

// ───────────────────────── change‑resolution endpoint ───────────────
app.post("/api/change-resolution", async (req, res) => {
  try {
    const orig  = req.body.resolution;
    const newRes = normalise(orig);
    const valid = ["1", "5", "15", "30", "60", "120", "240", "D"];

    if (!valid.includes(newRes)) return res.status(400).json({ error: `Invalid resolution ${orig}` });

    if (newRes === currentResolution) return res.json({ success: true });

    console.log(`🔄  resolution ${currentResolution} → ${newRes}`);
    currentResolution = newRes;

    if (strategy) await strategy.setResolution(newRes);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "internal" });
  }
});

// ───────────────────────── bootstrap ───────────────────────────────
async function bootstrap() {
  try {
    await tradingService.initialize();
    strategy = new Strategy(tradingService, io, currentResolution);

    const token      = await authManager.getAccessToken();
    const dataSocket = await connectDataSocket(token);

    dataSocket.on("message", msg => {
      if (msg?.type === "sf" && msg.symbol && msg.ltp) {
        strategy.updateRealtimeDataFromSF({ symbol: msg.symbol, ltp: msg.ltp });
      }
    });

    console.log("✅ server ready on", currentResolution, "resolution");
  } catch (err) {
    console.error("❌ bootstrap error:", err);
  }
}
bootstrap();

// ───────────────────────── start HTTP server ───────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));
