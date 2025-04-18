// server.js
require("dotenv").config({
  path: require("path").resolve(__dirname, "../.env"),
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const tradingService = require("./tradingService");
const cors = require('cors');
const authManager = require('./auth2.0');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Initialize trading service
let fyers = null;
let orderEmitter = null;
let dataEmitter = null;

// Initialize the trading service
async function initializeTradingService() {
  try {
    fyers = await authManager.initialize();
    console.log('Trading service initialized successfully');
  } catch (error) {
    console.error('Error initializing trading service:', error);
  }
}

// Initialize on startup
initializeTradingService();

// Connect to WebSockets if token is available
async function connectWebSockets() {
  try {
    const token = await authManager.getAccessToken();
    if (!token) {
      console.log('No access token available for WebSocket connections');
      return;
    }

    // Format token for WebSocket connections
    // For Fyers API v3 WebSocket, we need to combine app ID and token
    const socketToken = `${process.env.FYERS_APP_ID}:${token}`;
    
    // Connect to order socket
    console.log('Connecting to order socket...');
    orderEmitter = await tradingService.connectOrderSocket(socketToken);
    
    // Handle order socket errors
    orderEmitter.on('error', (error) => {
      console.error('Order socket error:', error);
      // Don't throw, just log the error
    });

    // Connect to data socket
    console.log('Connecting to data socket...');
    dataEmitter = await tradingService.connectDataSocket(socketToken);
    
    // Handle data socket errors
    dataEmitter.on('error', (error) => {
      console.error('Data socket error:', error);
      // Don't throw, just log the error
    });

  } catch (error) {
    console.error('Error connecting to WebSockets:', error);
    // Don't throw, just log the error and continue
  }
}

// Connect to WebSockets after a short delay to ensure token is available
setTimeout(connectWebSockets, 5000);

// API Routes
app.get("/", (req, res) => {
  res.send("Fyers Trading API is running 🔌");
});

// Profile and Account Info
app.get('/api/profile', async (req, res) => {
  try {
    const profile = await tradingService.getProfile();
    res.json(profile);
  } catch (error) {
    console.error('Error fetching profile:', error);
    res.status(500).json({ error: error.message || error });
  }
});

app.get('/api/funds', async (req, res) => {
  try {
    const funds = await tradingService.getFunds();
    res.json(funds);
  } catch (error) {
    console.error('Error fetching funds:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// Market Data
app.get('/api/history', async (req, res) => {
  try {
    const { symbol, resolution, fromDate, toDate } = req.query;
    
    // Validate required parameters
    if (!symbol) {
      return res.status(400).json({ error: 'Symbol is required' });
    }

    // Format the symbol to include -EQ suffix if not present
    let formattedSymbol = symbol;
    if (!symbol.includes('-EQ') && symbol.includes('NSE:')) {
      formattedSymbol = `${symbol}-EQ`;
    }

    const historicalData = await tradingService.getHistoricalData(
      formattedSymbol,
      resolution || 'D',
      fromDate,
      toDate
    );
    res.json(historicalData);
  } catch (error) {
    console.error('Error fetching historical data:', error);
    res.status(500).json({ error: error.message || error });
  }
});

app.get('/api/quotes', async (req, res) => {
  try {
    const { symbols } = req.query;
    // Make sure symbols is an array
    const symbolsArray = symbols ? symbols.split(',') : [];
    const quotes = await tradingService.getQuotes(symbolsArray);
    res.json(quotes);
  } catch (error) {
    console.error('Error fetching quotes:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// Position and Holdings
app.get('/api/positions', async (req, res) => {
  try {
    const positions = await tradingService.getPositions();
    res.json(positions);
  } catch (error) {
    console.error('Error fetching positions:', error);
    res.status(500).json({ error: error.message || error });
  }
});



app.get('/api/holdings', async (req, res) => {
  try {
    const holdings = await tradingService.getHoldings();
    res.json(holdings);
  } catch (error) {
    console.error('Error fetching holdings:', error);
    res.status(500).json({ error: error.message || error });
  }
});

// Order Book and Trade Book
app.get('/api/orderbook', async (req, res) => {
  try {
    const orderbook = await tradingService.getOrderBook();
    res.json(orderbook);
  } catch (error) {
    console.error('Error fetching order book:', error);
    res.status(500).json({ error: error.message || error });
  }
});

app.get('/api/tradebook', async (req, res) => {
  try {
    const tradebook = await tradingService.getTradeBook();
    res.json(tradebook);
  } catch (error) {
    console.error('Error fetching trade book:', error);
    res.status(500).json({ error: error.message || error });
  }
});



// Socket.IO connection handling
io.on("connection", (socket) => {
  console.log("↔️ Browser connected:", socket.id);

  if (orderEmitter) {
    orderEmitter.on("orders", (msg) => socket.emit("orders", msg));
    orderEmitter.on("trades", (msg) => socket.emit("trades", msg));
    orderEmitter.on("positions", (msg) => socket.emit("positions", msg));
  }

  if (dataEmitter) {
    dataEmitter.on("ticks", (msg) => socket.emit("ticks", msg));
    dataEmitter.on("ohlc", (msg) => socket.emit("ohlc", msg));
  }

  socket.on("disconnect", () => {
    console.log("❌ Browser disconnected:", socket.id);
  });
});

// Update the bootstrap function to handle errors better
async function bootstrap() {
  try {
    // Initialize trading service
    await tradingService.initialize();
    console.log("✅ Trading service initialized");

    // Get profile to verify authentication
    const profile = await tradingService.getProfile();
    console.log("✅ Authenticated, profile:", profile);

    // Connect to WebSockets if HSM key is available
    if (tradingService.hsmKey) {
      console.log("Connecting to order socket...");
      const orderSocket = tradingService.connectOrderSocket(process.env.FYERS_ACCESS_TOKEN);
      
      console.log("Connecting to data socket...");
      const dataSocket = tradingService.connectDataSocket(process.env.FYERS_ACCESS_TOKEN);
      
      // Set up WebSocket event handlers
      orderSocket.on('error', (error) => {
        console.error('⚠️ OrderSocket Error:', error);
      });
      
      dataSocket.on('error', (error) => {
        console.error('⚠️ DataSocket Error:', error);
      });
      
      console.log("✅ WebSocket connections established");
    } else {
      console.warn("⚠️ HSM key not found. WebSocket connections may not work properly.");
      console.warn("Please make sure your access token includes the HSM key.");
      console.warn("Continuing without WebSocket connections...");
    }

    // Start the server
    const PORT = process.env.PORT || 4000;
    server.listen(PORT, () => {
      console.log(`🔌 Fyers Trading API listening on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ Error during bootstrap:", error);
    process.exit(1);
  }
}

// Add error handlers to prevent unhandled errors from crashing the application
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Don't exit the process, just log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit the process, just log the error
});

bootstrap();
