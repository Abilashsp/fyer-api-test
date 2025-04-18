const { fyersOrderSocket } = require('fyers-api-v3');
const { EventEmitter } = require('events');

class OrderSocket extends EventEmitter {
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

      // Initialize WebSocket connection using fyersOrderSocket
      this.socket = new fyersOrderSocket(
        this.accessToken,
        "./logs", // Path to save logs
        true // Enable logging
      );

      // Set up event handlers
      this.socket.on('connect', () => {
        console.log('✅ Order socket connected successfully');
        this.connected = true;
        this.emit('connect');
        
        // Subscribe to all order updates
        this.socket.subscribe([
          this.socket.orderUpdates,
          this.socket.tradeUpdates,
          this.socket.positionUpdates,
          this.socket.edis,
          this.socket.pricealerts
        ]);
      });

      this.socket.on('close', () => {
        console.log('⚠️ Order socket connection closed');
        this.connected = false;
        this.emit('close');
      });

      this.socket.on('error', (error) => {
        console.error('❌ Order socket error:', error);
        this.emit('error', error);
      });

      this.socket.on('orders', (message) => {
        this.emit('orders', message);
      });

      this.socket.on('trades', (message) => {
        this.emit('trades', message);
      });

      this.socket.on('positions', (message) => {
        this.emit('positions', message);
      });

      this.socket.on('others', (message) => {
        this.emit('others', message);
      });

      // Connect to WebSocket
      this.socket.connect();

      return this;
    } catch (error) {
      console.error('❌ Error connecting to order socket:', error);
      this.emit('error', error);
      throw error;
    }
  }

  disconnect() {
    try {
      if (this.connected && this.socket) {
        this.socket.close();
        this.connected = false;
        console.log('✅ Order socket disconnected');
      }
    } catch (error) {
      console.error('❌ Error disconnecting order socket:', error);
      throw error;
    }
  }
}

async function connect(fyers, accessToken) {
  const socket = new OrderSocket(fyers, accessToken);
  await socket.connect();
  return socket;
}

module.exports = {
  connect,
  OrderSocket
};
