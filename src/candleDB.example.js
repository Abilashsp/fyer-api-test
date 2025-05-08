const CandleDB = require('./candleDB');
const moment = require('moment');

// Example usage with Strategy class
async function example() {
  // Initialize the database
  const candleDB = new CandleDB('data/candles.db');

  // Example: Update daily data for multiple symbols
  async function updateDailyData(symbols) {
    const symbolsToUpdate = candleDB.getSymbolsNeedingUpdate(symbols);
    
    for (const symbol of symbolsToUpdate) {
      try {
        // Get historical data from Fyers API
        const { candles } = await tradingService.getHistoricalData(symbol, "D", 300);
        
        // Store in SQLite cache
        candleDB.storeDailyCandles(symbol, candles);
        
        // Pre-calculate and cache SMAs
        candleDB.cacheSMA(symbol, "D", 20, candles);
        candleDB.cacheSMA(symbol, "D", 50, candles);
        candleDB.cacheSMA(symbol, "D", 200, candles);
        
        console.log(`✅ Updated ${symbol} data`);
      } catch (error) {
        console.error(`❌ Failed to update ${symbol}:`, error.message);
      }
    }
  }

  // Example: Get daily data for a symbol
  function getDailyData(symbol, days = 300) {
    const endTs = moment().unix();
    const startTs = moment().subtract(days, 'days').unix();
    
    return candleDB.getDailyCandles(symbol, startTs, endTs);
  }

  // Example: Get cached SMA
  function getSMA(symbol, period) {
    const cached = candleDB.getCachedSMA(symbol, "D", period);
    if (cached) {
      return cached.value;
    }
    return null;
  }

  // Example: Integration with Strategy class
  class Strategy {
    constructor(tradingService) {
      this.tradingService = tradingService;
      this.candleDB = new CandleDB('data/candles.db');
    }

    async #ensureDaily(symbol) {
      if (this.candleDB.needsUpdate(symbol)) {
        console.log(`🔄 Fetching daily data for ${symbol} from API`);
        const { candles } = await this.tradingService.getHistoricalData(symbol, "D", 300);
        this.candleDB.storeDailyCandles(symbol, candles);
      }
      return this.candleDB.getDailyCandles(
        symbol,
        moment().subtract(300, 'days').unix(),
        moment().unix()
      );
    }

    async #ensureSMA(symbol, period) {
      const cached = this.candleDB.getCachedSMA(symbol, "D", period);
      if (!cached) {
        const candles = await this.#ensureDaily(symbol);
        this.candleDB.cacheSMA(symbol, "D", period, candles);
        return this.candleDB.getCachedSMA(symbol, "D", period).value;
      }
      return cached.value;
    }

    // ... rest of Strategy class implementation
  }

  // Clean up
  process.on('SIGINT', () => {
    candleDB.close();
    process.exit(0);
  });
}

module.exports = example; 