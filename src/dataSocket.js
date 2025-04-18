// src/dataSocket.js

const { fyersDataSocket } = require('fyers-api-v3');
const { EventEmitter } = require('events');

class DataSocket extends EventEmitter {
  constructor(fyers, accessToken) {
    super();
    this.fyers = fyers;
    this.accessToken = accessToken;
    this.connected = false;
    this.socket = null;
  }

  async connect() {
    try {
      if (!this.fyers || !this.accessToken) {
        throw new Error('Fyers instance or access token not available');
      }

      // Initialize WebSocket connection using fyersDataSocket
      this.socket = fyersDataSocket.getInstance(
        this.accessToken,
        "./logs", // Path to save logs
        true // Enable logging
      );

      // Set up event handlers
      this.socket.on('connect', () => {
        console.log('✅ Data socket connected successfully');
        this.connected = true;
        this.emit('connect');
        
        // Subscribe to market data for some default symbols
        // You can modify this to subscribe to your desired symbols
        this.socket.subscribe(['NSE:SBIN-EQ', 'NSE:TCS-EQ']);
        
        // Enable lite mode for fewer data points
        this.socket.mode(this.socket.LiteMode);
      });

      this.socket.on('close', () => {
        console.log('⚠️ Data socket connection closed');
        this.connected = false;
        this.emit('close');
      });

      this.socket.on('error', (error) => {
        console.error('❌ Data socket error:', error);
        this.emit('error', error);
      });

      this.socket.on('message', (message) => {
        // Log the message to console
        console.log('📊 Data socket message:', JSON.stringify(message, null, 2));
        this.emit('message', message);
      });

      // Connect to WebSocket
      this.socket.connect();

      return this;
    } catch (error) {
      console.error('❌ Error connecting to data socket:', error);
      this.emit('error', error);
      throw error;
    }
  }

  disconnect() {
    try {
      if (this.connected && this.socket) {
        this.socket.close();
        this.connected = false;
        console.log('✅ Data socket disconnected');
      }
    } catch (error) {
      console.error('❌ Error disconnecting data socket:', error);
      throw error;
    }
  }
  
  // Method to subscribe to specific symbols
  subscribe(symbols, isMarketDepth = false) {
    if (this.connected && this.socket) {
      console.log(`📈 Subscribing to symbols: ${symbols.join(', ')}`);
      this.socket.subscribe(symbols, isMarketDepth);
    }
  }
  
  // Method to switch between lite and full mode
  setMode(mode) {
    if (this.connected && this.socket) {
      if (mode === 'lite') {
        console.log('🔄 Switching to lite mode');
        this.socket.mode(this.socket.LiteMode);
      } else if (mode === 'full') {
        console.log('🔄 Switching to full mode');
        this.socket.mode(this.socket.FullMode);
      }
    }
  }
  
  // Method to enable auto reconnect
  enableAutoReconnect(retryCount = 6) {
    if (this.connected && this.socket) {
      console.log(`🔄 Enabling auto reconnect with retry count: ${retryCount}`);
      this.socket.autoReconnect(retryCount);
    }
  }
}

async function connect(fyers, accessToken) {
  const socket = new DataSocket(fyers, accessToken);
  await socket.connect();
  return socket;
}

module.exports = {
  connect,
  DataSocket
};
