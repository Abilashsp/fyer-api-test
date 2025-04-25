// server.js
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const authManager = require("./auth2.0");
const tradingService = require("./tradingService");
const TradingStrategy = require("./strategy");
const { connect: connectDataSocket, nifty50Symbols } = require("./dataSocket");
const entryTimeService = require("./services/entryTimeService");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true
  } 
});

app.use(cors());
app.use(express.json());

// Add root route handler for Fyers authentication callback
app.get("/", (req, res) => {
  const { auth_code, state } = req.query;
  
  if (auth_code) {
    console.log("✅ Received auth code from Fyers:", auth_code);
    // Pass the auth code to the auth manager
    authManager.setAuthCode(auth_code);
    
    // Send a success response to the browser
    res.send(`
      <html>
        <head>
          <title>Authentication Successful</title>
          <style>
            body {
              font-family: Arial, sans-serif;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              margin: 0;
              background-color: #f5f5f5;
            }
            .container {
              text-align: center;
              padding: 2rem;
              background-color: white;
              border-radius: 8px;
              box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            }
            h1 {
              color: #4CAF50;
            }
            p {
              color: #666;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>Authentication Successful!</h1>
            <p>You can close this window and return to the application.</p>
          </div>
        </body>
      </html>
    `);
  } else {
    res.status(400).send("Authentication failed: No auth code received");
  }
});

// Add health check endpoint
app.get("/api/health", (req, res) => {
  res.json({ 
    status: "ok", 
    message: "Server is running",
    time: new Date().toISOString()
  });
});

// Add endpoint to get bullish signals
app.get("/api/bullish-signals", (req, res) => {
  if (!tradingStrategy) {
    return res.status(503).json({ 
      error: "Trading strategy not initialized yet" 
    });
  }
  
  const signals = tradingStrategy.getBullishSignals();
  res.json({ 
    count: signals.length,
    signals 
  });
});

// Add endpoint to get strategy signals
app.get("/api/strategy/signals", async (req, res) => {
  if (!tradingStrategy) {
    return res.status(503).json({ 
      error: "Trading strategy not initialized yet" 
    });
  }
  
  try {
    // Get symbols from query parameter or use all Nifty 50 symbols
    const symbols = req.query.symbols ? 
      req.query.symbols.split(',') : 
      nifty50Symbols;
    
    // Get resolution from query parameter or use default
    const resolution = req.query.resolution || tradingStrategy.defaultResolution;
    
    console.log(`📊 Analyzing ${symbols.length} symbols with resolution ${resolution}`);
    
    // Run the analysis
    const results = await tradingStrategy.analyzeMultiple(symbols, resolution);
    
    // Return the results
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: results.length,
      signals: results
    });
  } catch (error) {
    console.error("Error analyzing symbols:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Unknown error occurred"
    });
  }
});

// Add endpoint to get entry times for all symbols
app.get("/api/entrytimes", async (req, res) => {
  try {
    const resolution = req.query.resolution || '240';
    const symbols = req.query.symbols ? 
      req.query.symbols.split(',') : 
      nifty50Symbols;
    
    console.log(`📊 Fetching entry times for ${symbols.length} symbols (${resolution})`);
    
    const entryTimes = await entryTimeService.getAllEntryTimes(symbols, resolution);
    
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: entryTimes.length,
      resolution,
      entryTimes
    });
  } catch (error) {
    console.error("Error fetching entry times:", error);
    res.status(500).json({
      success: false,
      error: error.message || "Unknown error occurred"
    });
  }
});

let tradingStrategy;

async function bootstrap() {
  try {
    console.log("🚀 Initializing trading service...");
    await tradingService.initialize();
    
    console.log("📊 Initializing trading strategy...");
    tradingStrategy = new TradingStrategy(tradingService, io);

    console.log("🔑 Getting access token...");
    const token = await authManager.getAccessToken();
    
    console.log("🔌 Connecting to data socket...");
    const dataSocket = await connectDataSocket(token);

    // Handle data socket events
    dataSocket.on("connect", () => {
      console.log("✅ Data socket connected successfully");
    });

    dataSocket.on("error", (err) => {
      console.error("❌ Data socket error:", err);
    });

    dataSocket.on("close", () => {
      console.log("⚠️ Data socket closed");
    });

    // Process incoming messages
    dataSocket.on("message", (msg) => {
      // Log the message for debugging
      // console.log(`📊 Received message for ${msg.symbol}:`, {
      //   symbol: msg.symbol,
      //   ltp: msg.ltp,
      //   open: msg.open_price,
      //   high: msg.high_price,
      //   low: msg.low_price,
      //   volume: msg.vol_traded_today
      // });
      
      if (msg?.type === "sf") {
        // Process the symbol feed message
        tradingStrategy.updateRealtimeDataFromSF(msg);
        // Forward the message to all connected clients
        io.emit("message", msg);
      }
    });

    // Set up Socket.IO connection handling
    io.on("connection", (socket) => {
      console.log("↔️ Client connected:", socket.id);

      // Send current bullish signals to the newly connected client
      const signals = tradingStrategy.getBullishSignals();
      if (signals.length > 0) {
        socket.emit("bullishSignals", signals);
      }

      socket.on("disconnect", () => {
        console.log("❌ Client disconnected:", socket.id);
      });
    });

    console.log("✅ Server and socket data stream initialized");
  } catch (error) {
    console.error("❌ Error during bootstrap:", error);
  }
}

bootstrap();

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server listening at http://localhost:${PORT}`);
});
