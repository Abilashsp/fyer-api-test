// dataSocket.js
const { fyersDataSocket } = require("fyers-api-v3");
const { EventEmitter } = require("events");
const WebSocket = require('ws');

// Nifty 50 symbols
const nifty50Symbols = [
"NSE:MOGSEC-EQ","NSE:NH-EQ","NSE:TATVA-EQ","NSE:POLYMED-EQ","NSE:RRKABEL-EQ","NSE:PAYTM-EQ","NSE:KPRMILL-EQ","NSE:APARINDS-EQ","NSE:ORICONENT-EQ","NSE:SHYAMMETL-EQ","NSE:KRISHANA-EQ"
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

  // Entry time tracking removed with SQLite integration
  updateEntryTime(symbol, data) {
    // This method has been simplified as part of SQLite removal
    // No database operations are performed anymore
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
