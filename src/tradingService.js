const { fyersModel } = require('fyers-api-v3');
const authManager = require('./auth2.0');
const { EventEmitter } = require('events');
const orderSocket = require('./orderSocket');
const dataSocket = require('./dataSocket');

// Simple sleep helper
const sleep = ms => new Promise(res => setTimeout(res, ms));

// Improved rate limiter class with token bucket algorithm
class RateLimiter {
  constructor(maxRequests, timeWindowMs) {
    this.maxRequests = maxRequests;
    this.timeWindowMs = timeWindowMs;
    this.tokens = maxRequests;
    this.lastRefillTime = Date.now();
    this.refillRate = maxRequests / (timeWindowMs / 1000); // tokens per second
  }

  async waitForSlot() {
    this.refillTokens();
    
    if (this.tokens < 1) {
      // Calculate wait time based on tokens needed
      const tokensNeeded = 1;
      const waitTime = Math.ceil((tokensNeeded / this.refillRate) * 1000);
      console.log(`⏳ Rate limit reached, waiting ${waitTime}ms...`);
      await sleep(waitTime);
      return this.waitForSlot(); // Try again after waiting
    }
    
    // Consume a token
    this.tokens -= 1;
  }

  refillTokens() {
    const now = Date.now();
    const timePassed = now - this.lastRefillTime;
    const tokensToAdd = (timePassed / 1000) * this.refillRate;
    
    if (tokensToAdd > 0) {
      this.tokens = Math.min(this.maxRequests, this.tokens + tokensToAdd);
      this.lastRefillTime = now;
    }
  }
}

// Create a rate limiter instance: 8 requests per minute (more balanced)
const rateLimiter = new RateLimiter(8, 60 * 1000);

class TradingService {
  constructor() {
    this.fyers = null;
    this.orderSocket = null;
    this.dataSocket = null;
    this.hsmKey = null;
    this.requestCount = 0;
    this.lastRequestTime = 0;
    this.cache = new Map(); // Simple in-memory cache
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes
  }

  async initialize() {
    try {
      // Initialize Fyers instance
      this.fyers = await authManager.initialize();
      
      return this;
    } catch (error) {
      console.error('Error initializing trading service:', error);
      throw error;
    }
  }

  // Market Data Methods
  async getHistoricalData(symbol, resolution = 'D', fromDate, toDate) {
    try {
      // Wait for a rate limit slot
      await rateLimiter.waitForSlot();
      
      // Add a small delay between requests (reduced from 1000ms to 500ms)
      const now = Date.now();
      const timeSinceLastRequest = now - this.lastRequestTime;
      if (timeSinceLastRequest < 500) {
        await sleep(500 - timeSinceLastRequest);
      }
      this.lastRequestTime = Date.now();
      
      // Convert dates to epoch timestamps if they're not already
      const fromEpoch = fromDate ? new Date(fromDate).getTime() / 1000 : undefined;
      const toEpoch = toDate ? new Date(toDate).getTime() / 1000 : undefined;
      
      const params = {
        symbol,
        resolution,
        date_format: '0', // 0 for epoch timestamps
        range_from: fromEpoch,
        range_to: toEpoch,
        cont_flag: '1'
      };
      
      console.log(`📊 Fetching historical data for ${symbol} (${resolution})`);
      
      // Implement retry logic with exponential backoff
      let retries = 3; // Reduced from 4 to 3
      let delay = 1000; // Reduced from 2000 to 1000
      
      while (retries > 0) {
        try {
          const response = await this.fyers.getHistory(params);
          
          // Check if the response is valid
          if (response && response.s === 'ok' && response.candles) {
            const result = {
              success: true,
              candles: response.candles.map(candle => ({
                timestamp: candle[0],  // Epoch timestamp
                open: candle[1],       // Opening price
                high: candle[2],       // Highest price
                low: candle[3],        // Lowest price
                close: candle[4],      // Closing price
                volume: candle[5]      // Trading volume
              }))
            };
            
            console.log(`✅ Successfully fetched ${result.candles.length} candles for ${symbol}`);
            return result;
          } else {
            throw new Error('Invalid response format from Fyers API');
          }
        } catch (error) {
          retries--;
          
          // Check if it's a rate limit error
          if (error.code === 429 || (error.message && error.message.includes('request limit reached'))) {
            console.warn(`⚠️ Rate limited, retrying in ${delay}ms... (${retries} attempts left)`);
            await sleep(delay);
            delay *= 1.5; // Reduced exponential backoff factor from 2 to 1.5
          } else {
            // If it's not a rate limit error, throw it
            throw error;
          }
          
          // If we've run out of retries, throw the last error
          if (retries === 0) {
            throw error;
          }
        }
      }
    } catch (error) {
      console.error('Error fetching historical data:', error);
      throw error;
    }
  }

  // Profile and Account Info
  async getProfile() {
    try {
      return await this.fyers.get_profile();
    } catch (error) {
      console.error('Error fetching profile:', error);
      throw error;
    }
  }

  // WebSocket Methods
  async connectOrderSocket(socketToken) {
    try {
      if (!socketToken) {
        throw new Error('Socket token is required');
      }
      
      console.log('Connecting to order socket with token:', socketToken.substring(0, 10) + '...');
      return await orderSocket.connect(socketToken);
    } catch (error) {
      console.error('Error connecting to order socket:', error);
      throw error;
    }
  }

  async connectDataSocket(socketToken) {
    try {
      if (!socketToken) {
        throw new Error('Socket token is required');
      }

      console.log('Connecting to data socket with token:', socketToken.substring(0, 10) + '...');
      return await dataSocket.connect(socketToken);
    } catch (error) {
      console.error('Error connecting to data socket:', error);
      throw error;
    }
  }
}

module.exports = new TradingService(); 