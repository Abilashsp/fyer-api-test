// server.js – updated to use POST for resolution + new strategy integration

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

let strategy; // Strategy instance

// ───────────────────────── socket hydration ─────────────────────────
io.on("connection", sock => {
  console.log("👋  UI connected");
  if (strategy) {
    // Emit initial signals in the format the React client expects
    const bullishSignals = strategy.getBullishSignals();
    console.log(`Emitting ${bullishSignals.length} bullish signals to new client`);
    sock.emit("initialBullishSignals", bullishSignals);
    sock.emit("initialBearishSignals", strategy.getBearishSignals?.() || []);
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

// ───────────────────────── bootstrap logic ──────────────────────────
async function bootstrap() {
  try {
    await authManager.initialize();
    await tradingService.initialize();

    strategy = new Strategy(tradingService, io);

    const token = await authManager.getAccessToken();
    if (!token) throw new Error('Failed to get access token');

    const dataSocket = await connectDataSocket(token);

    dataSocket.on("message", msg => {
      
      if (msg?.type === "sf" && msg.symbol && msg.ltp) {
        strategy.updateRealtimeDataFromSF({ symbol: msg.symbol, ltp: msg.ltp });
      }
    });

    // await strategy.analyzeCurrentData();

    console.log("✅ server ready with multi-timeframe strategy");
  } catch (err) {
    console.error("❌ bootstrap error:", err);
    process.exit(1);
  }
}
bootstrap();

// ───────────────────────── API endpoints ───────────────────────────

// POST /api/change-resolution — set SMA resolution dynamically
app.post("/api/change-resolution", async (req, res) => {
  try {
    const { resolution } = req.body;

    if (!resolution) {
      return res.status(400).json({
        success: false,
        message: "Resolution parameter is required",
        current: strategy?.getResolution?.()
      });
    }

    const newResolution = strategy.setResolution(resolution);
    console.log(`🔄 Changed SMA resolution to ${newResolution}`);

    // Analyze data with new resolution
    const results = await strategy.analyzeCurrentData();
    
    // Get updated signals
    const bullishSignals = strategy.getBullishSignals();
    
    // Emit to all connected clients
    io.emit("initialBullishSignals", bullishSignals);
    console.log(`Emitting ${bullishSignals.length} bullish signals after resolution change to ${newResolution}`);
    
    // Also emit empty bearish signals to keep UI in sync
    io.emit("initialBearishSignals", []);

    return res.json({
      success: true,
      resolution: newResolution,
      message: `Resolution changed to ${newResolution}`,
      bullishSignals: bullishSignals,
      analysisCount: results.length
    });
  } catch (err) {
    console.error("❌ Change resolution error:", err.message);
    return res.status(400).json({
      success: false,
      message: err.message
    });
  }
});

// GET /api/resolution — return current SMA resolution
app.get("/api/resolution", (req, res) => {
  const current = strategy?.getResolution?.();
  return res.json({ success: true, resolution: current });
});

// ───────────────────────── start HTTP server ───────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀  http://localhost:${PORT}`));
