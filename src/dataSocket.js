// dataSocket.js
const { fyersDataSocket } = require("fyers-api-v3");
const { EventEmitter } = require("events");
const WebSocket = require('ws');
const entryTimeService = require('./services/entryTimeService');

// Nifty 50 symbols
const nifty50Symbols = [
  "NSE:SILVERTUC-EQ",
  "NSE:DIXON-EQ",
  "NSE:HITACHIENERGY-EQ",
  "NSE:IEX-EQ",
  "NSE:BANKBARODA-EQ",
  "NSE:FAZE3Q-EQ",
  "NSE:AXISBANK-EQ","NSE:BAJFINANCE-EQ","NSE:DLF-EQ","NSE:DMART-EQ","NSE:BALKRISIND-EQ","NSE:AARTIPHARM-EQ","NSE:KAYNES-EQ","NSE:CIGNITITEC-EQ",
];


class DataSocket extends EventEmitter {
  constructor(accessToken) {
    super();
    this.accessToken = accessToken;
    this.socket = null;
    this.connected = false;
    this.symbols = [...nifty50Symbols]; 
    this.lastMessageTime = {};
  }

  async connect() {
    if (!this.accessToken) throw new Error("Access token not provided");

    this.socket = fyersDataSocket.getInstance(this.accessToken, "./logs", true);

    this.socket.on("connect", () => {
      console.log("✅ Data socket connected");
      this.connected = true;
      this.emit("connect");
      
      // Subscribe to all Nifty 50 symbols
      this.subscribe(this.symbols);
      this.socket.mode(this.socket.FullMode);
      
      // Enable auto-reconnect
      this.socket.autoreconnect();
    });

    this.socket.on("close", () => {
      console.log("❌ Data socket closed");
      this.connected = false;
      this.emit("close");
    });

    this.socket.on("error", (err) => {
      console.error("❗ Socket error:", err);
      this.emit("error", err);
    });

    this.socket.on("message", (msg) => {
      try {
        // Fyers socket already returns parsed JSON objects
        // No need to parse if it's already an object
        const data = typeof msg === "string" ? JSON.parse(msg) : msg;
        
        if (data && data.type === "sf") {
          const symbol = data.symbol;
          
          // Update last message time
          this.lastMessageTime[symbol] = Date.now();
          
          // Update entry time for the symbol
          this.updateEntryTime(symbol, data);
          
          // Emit the message
          this.emit("message", data);
        }
      } catch (error) {
        console.error("Error processing message:", error);
      }
    });

    this.socket.connect();
    return this;
  }

  disconnect() {
    if (this.connected && this.socket) {
      this.socket.close();
      this.connected = false;
      console.log("✅ Data socket disconnected");
    }
  }

  subscribe(symbols) {
    if (!this.connected || !this.socket) {
      console.warn("⚠️ Cannot subscribe: socket not connected");
      return;
    }
    
    // Update the symbols list
    this.symbols = symbols;
    
    // Subscribe to the symbols
    console.log(`📈 Subscribing to ${symbols.length} symbols`);
    this.socket.subscribe(symbols);
  }

  getLastMessageTime(symbol) {
    return this.lastMessageTime[symbol] || 0;
  }

  isSymbolActive(symbol, maxAgeMs = 60000) { // Default 1 minute
    const lastTime = this.getLastMessageTime(symbol);
    return (Date.now() - lastTime) < maxAgeMs;
  }

  async updateEntryTime(symbol, data) {
    try {
      const resolutions = ['1', '5', '15', '30', '60', '240', 'D'];
      
      for (const resolution of resolutions) {
        const entryTimeData = await entryTimeService.getEntryTime(symbol, resolution);
        const isStale = await entryTimeService.isEntryTimeStale(symbol, resolution);
        
        if (!entryTimeData || isStale) {
          // Calculate new entry time based on current data
          const lastCandleTime = Math.floor(Date.now() / 1000);
          const entryTime = entryTimeService.calculateNextEntryTime(lastCandleTime, resolution);
          
          // Update entry time in database
          await entryTimeService.updateEntryTime(symbol, resolution, entryTime, lastCandleTime);
        }
      }
    } catch (error) {
      console.error(`Error updating entry time for ${symbol}:`, error);
    }
  }
}

async function connect(accessToken) {
  const ds = new DataSocket(accessToken);
  await ds.connect();
  return ds;
}

module.exports = {
  connect,
  DataSocket,
  nifty50Symbols
};
