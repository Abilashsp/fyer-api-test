const moment = require("moment");
const sleep = require("util").promisify(setTimeout);
const sqliteService = require("./services/sqliteService");

// simple sleep helper
const sleepHelper = ms => new Promise(res => setTimeout(res, ms));



const RESOLUTIONS = {
  MINUTE_1: "1",
  MINUTE_5: "5",
  MINUTE_15: "15",
  MINUTE_30: "30",
  HOUR_1: "60",
  HOUR_4: "240",
  DAY_1: "D"
};

class TradingStrategy {
  constructor(tradingService, io = null) {
    this.tradingService = tradingService;
    this.io = io;
    this.requestDelayMs = 5000;
    this._cache = new Map();
    this.bullishSignals = new Map();
    this.processingQueue = new Set();
    this.defaultResolution = RESOLUTIONS.DAY_1;
    this.batchSize = 5;
    this.maxRetries = 3;
    this.failedSymbols = new Set();
    this.parallelRequests = 2;
    this.lastAnalysisTime = 0;
    this.analysisResults = null;
    this.analysisExpiry = 5 * 60 * 1000;
  }

  async getCandles(symbol = "NSE:RELIANCE-EQ", resolution = this.defaultResolution) {
    if (this.processingQueue.has(symbol)) {
      await sleep(500);
      return this._cache.get(symbol)?.candles || [];
    }

    this.processingQueue.add(symbol);
    try {
      // Check if we have cached data
      const isStale = await sqliteService.isDataStale(symbol, resolution);
      const cachedData = await sqliteService.getSymbolData(symbol, resolution);
      const lastCandleTime = await sqliteService.getLastCandleTime(symbol, resolution);
      
      // If we have valid cached data, use it
      if (cachedData && !isStale) {
        console.log(`📊 Using cached data for ${symbol}`);
        const cache = this._cache.get(symbol) || {};
        cache.highestHigh = cachedData.highest_high;
        cache.highestLow = cachedData.highest_low;
        cache.lastUpdated = cachedData.last_fetch_time;
        this._cache.set(symbol, cache);
        return cache.candles || [];
      }

      const now = moment().unix();
      let from;

      // If we have a last candle time, fetch from that point
      if (lastCandleTime) {
        from = lastCandleTime + 1; // Start from the next candle
        console.log(`🔄 Fetching new candles for ${symbol} from ${moment.unix(from).format("YYYY-MM-DD HH:mm")}`);
      } else {
        // Calculate initial fetch period
        const requiredCount = 100;
        const resMin = parseInt(resolution, 10);
        const resSec = resMin * 60;
        const open = moment().startOf("day").add(9, "hours").add(15, "minutes");
        const close = moment().startOf("day").add(15, "hours").add(15, "minutes");
        const sessionSec = close.unix() - open.unix();
        const candlesPerDay = Math.max(1, Math.floor(sessionSec / resSec));
        const tradingDaysNeeded = Math.ceil(requiredCount / candlesPerDay);
        let calendarDays = Math.ceil(tradingDaysNeeded * 7 / 5);
        if (calendarDays > 99) calendarDays = 99;
        from = moment().subtract(calendarDays, "days").unix();
        console.log(`🔄 Fetching initial candles for ${symbol} from ${moment.unix(from).format("YYYY-MM-DD HH:mm")}`);
      }
      
      let retryCount = 0;
      let success = false;
      let data;
      
      while (retryCount < this.maxRetries && !success) {
        try {
          data = await this.tradingService.getHistoricalData(symbol, resolution, from * 1000, now * 1000);
          success = true;
        } catch (err) {
          retryCount++;
          console.error(`❌ Error fetching candles for ${symbol} (attempt ${retryCount}/${this.maxRetries}):`, err.message || err);
          
          if (retryCount < this.maxRetries) {
            const delay = 3000 * retryCount;
            console.log(`⏳ Retrying in ${delay}ms...`);
            await sleep(delay);
          } else {
            this.failedSymbols.add(symbol);
            console.error(`❌ Failed to fetch candles for ${symbol} after ${this.maxRetries} attempts`);
            return [];
          }
        }
      }
      
      if (!data || !data.success) {
        console.error(`❌ Invalid data received for ${symbol}`);
        return [];
      }

      // Process new candles
      let newCandles = data.candles.map(c => ({
        time: moment.unix(c.timestamp).format("YYYY-MM-DD HH:mm"),
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }));

      // Remove duplicates and sort by timestamp
      const seen = new Set();
      newCandles = newCandles.filter(c => (seen.has(c.timestamp) ? false : seen.add(c.timestamp)));
      newCandles.sort((a, b) => a.timestamp - b.timestamp);

      // Get existing candles from cache
      const existingCandles = this._cache.get(symbol)?.candles || [];
      
      // Merge new candles with existing ones
      const mergedCandles = [...existingCandles];
      for (const newCandle of newCandles) {
        const existingIndex = mergedCandles.findIndex(c => c.timestamp === newCandle.timestamp);
        if (existingIndex === -1) {
          mergedCandles.push(newCandle);
        } else {
          mergedCandles[existingIndex] = newCandle;
        }
      }

      // Sort merged candles by timestamp
      mergedCandles.sort((a, b) => a.timestamp - b.timestamp);

      // Keep only the last 100 candles
      const finalCandles = mergedCandles.slice(-100);

      // Calculate new highest values
      const highestHigh = Math.max(...finalCandles.map(c => c.high));
      const highestLow = Math.max(...finalCandles.map(c => c.low));
      const lastCandleTimestamp = finalCandles[finalCandles.length - 1].timestamp;

      // Update SQLite cache with new values
      await sqliteService.updateSymbolData(
        symbol, 
        resolution, 
        highestHigh, 
        highestLow, 
        lastCandleTimestamp
      );

      const cache = {
        candles: finalCandles,
        highestHigh,
        highestLow,
        lastUpdated: Date.now()
      };

      this._cache.set(symbol, cache);

      console.log(`✅ Successfully updated cache for ${symbol} with ${newCandles.length} new candles`);
      return finalCandles;
    } catch (err) {
      console.error(`❌ Error fetching candles for ${symbol}:`, err.message || err);
      this.failedSymbols.add(symbol);
      return [];
    } finally {
      this.processingQueue.delete(symbol);
    }
  }

  isBullish(curr, cache, symbol) {
    if (!curr || !cache) {
      return false;
    }

    return (
      curr.close >= curr.open && // Current candle is green
      curr.high >= cache.highestHigh && // Current high is higher than historical high
      curr.low >= cache.highestLow // Current low is higher than historical low
    );
  }

  updateRealtimeDataFromSF(msg) {
    if (!msg || !msg.symbol) return;

    const symbol = msg.symbol;
    const cache = this._cache.get(symbol);

    if (!cache) {
      this.getCandles(symbol).then(() => this.updateRealtimeDataFromSF(msg));
      return;
    }

    const now = Date.now();
    if (now - cache.lastUpdated > 24 * 60 * 60 * 1000) {
      this.getCandles(symbol).then(() => this.updateRealtimeDataFromSF(msg));
      return;
    }

    const curr = {
      open: msg.open_price,
      high: msg.high_price,
      low: msg.low_price,
      close: msg.ltp,
      volume: msg.vol_traded_today
    };

    if (this.isBullish(curr, cache, symbol)) {
      const timestamp = moment().format("YYYY-MM-DD HH:mm:ss");
      this.bullishSignals.set(symbol, { symbol, signal: curr, timestamp });
      if (this.io) {
        this.io.emit("bullishSignal", { symbol, signal: curr, timestamp });
      }
    }
  }

  getBullishSignals() {
    return Array.from(this.bullishSignals.values());
  }

  async processBatch(symbols, resolution) {
    const results = [];
    const todayStr = moment().format("YYYY-MM-DD");
    
    const chunks = [];
    for (let i = 0; i < symbols.length; i += this.parallelRequests) {
      chunks.push(symbols.slice(i, i + this.parallelRequests));
    }
    
    for (const chunk of chunks) {
      const promises = chunk.map(async (sym) => {
        const cached = this._cache.get(sym);
        if (!cached || cached.lastUpdatedDay !== todayStr) {
          await this.getCandles(sym, resolution);
        }
        
        const fresh = this._cache.get(sym);
        const candles = fresh?.candles || [];
        if (candles.length < 2) return null;
        
        const idx = [...candles].reverse().findIndex(c => c.time.startsWith(todayStr));
        if (idx === -1) return null;
        
        const lastIdx = candles.length - 1 - idx;
        if (lastIdx === 0) return null;
        
        const curr = candles[lastIdx];
        if (this.isBullish(curr, fresh, sym)) {
          return {
            success: true,
            symbol: sym,
            resolution,
            totalCandles: candles.length,
            signal: curr,
            lastUpdated: moment().format("YYYY-MM-DD HH:mm:ss")
          };
        }
        
        return null;
      });
      
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults.filter(Boolean));
      
      if (chunks.indexOf(chunk) < chunks.length - 1) {
        await sleep(1000);
      }
    }
    
    return results;
  }

  async analyzeMultiple(symbols = [], resolution = this.defaultResolution) {
    const now = Date.now();
    if (this.analysisResults && (now - this.lastAnalysisTime < this.analysisExpiry)) {
      console.log("📊 Using cached analysis results");
      return this.analysisResults;
    }
    
    const filteredSymbols = symbols.filter(sym => !this.failedSymbols.has(sym));
    
    if (filteredSymbols.length < symbols.length) {
      console.log(`⚠️ Skipping ${symbols.length - filteredSymbols.length} previously failed symbols`);
    }
    
    console.log(`🔄 Starting analysis of ${filteredSymbols.length} symbols with resolution ${resolution}`);
    
    const results = [];
    for (let i = 0; i < filteredSymbols.length; i += this.batchSize) {
      const batch = filteredSymbols.slice(i, i + this.batchSize);
      console.log(`📊 Processing batch ${Math.floor(i/this.batchSize) + 1}/${Math.ceil(filteredSymbols.length/this.batchSize)} (${batch.length} symbols)`);
      
      const batchResults = await this.processBatch(batch, resolution);
      results.push(...batchResults);
      
      if (i + this.batchSize < filteredSymbols.length) {
        const batchDelay = this.requestDelayMs / 2;
        console.log(`⏳ Waiting ${batchDelay}ms before processing next batch...`);
        await sleep(batchDelay);
      }
    }
    
    this.analysisResults = results;
    this.lastAnalysisTime = now;
    
    console.log(`✅ Analysis complete. Found ${results.length} bullish signals.`);
    return results;
  }

  async getEntryTime(symbol, resolution = this.defaultResolution) {
    try {
      // Get candles for the symbol
      const candles = await this.getCandles(symbol, resolution);
      if (!candles || candles.length === 0) {
        return null;
      }

      // Get the last candle
      const lastCandle = candles[candles.length - 1];
      
      // Calculate entry time based on resolution
      const resMin = parseInt(resolution, 10);
      let entryTime;
      
      if (resolution === 'D') {
        // For daily candles, entry time is next day's open
        entryTime = moment(lastCandle.time).add(1, 'day').startOf('day').add(9, 'hours').add(15, 'minutes');
      } else {
        // For intraday candles, entry time is next candle's start
        entryTime = moment(lastCandle.time).add(resMin, 'minutes');
      }

      // Check if entry time is within market hours
      const marketOpen = moment().startOf('day').add(9, 'hours').add(15, 'minutes');
      const marketClose = moment().startOf('day').add(15, 'hours').add(15, 'minutes');
      
      // If entry time is after market close, move to next trading day
      if (entryTime.isAfter(marketClose)) {
        entryTime = moment(entryTime).add(1, 'day').startOf('day').add(9, 'hours').add(15, 'minutes');
      }
      
      // If entry time is before market open, move to market open
      if (entryTime.isBefore(marketOpen)) {
        entryTime = marketOpen;
      }

      return {
        time: entryTime.format('YYYY-MM-DD HH:mm:ss'),
        timestamp: entryTime.unix(),
        resolution,
        lastCandle: {
          time: lastCandle.time,
          open: lastCandle.open,
          high: lastCandle.high,
          low: lastCandle.low,
          close: lastCandle.close
        }
      };
    } catch (error) {
      console.error(`❌ Error calculating entry time for ${symbol}:`, error);
      throw error;
    }
  }

  async getAllEntryTimes(symbols, resolution = this.defaultResolution) {
    try {
      const results = [];
      const batchSize = 5; // Process symbols in batches to avoid overwhelming the API
      
      for (let i = 0; i < symbols.length; i += batchSize) {
        const batch = symbols.slice(i, i + batchSize);
        console.log(`📊 Processing batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(symbols.length/batchSize)}`);
        
        const batchPromises = batch.map(async (symbol) => {
          try {
            const entryTime = await this.getEntryTime(symbol, resolution);
            if (entryTime) {
              return {
                symbol,
                ...entryTime
              };
            }
            return null;
          } catch (error) {
            console.error(`❌ Error processing ${symbol}:`, error.message);
            return null;
          }
        });
        
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults.filter(Boolean));
        
        // Add a small delay between batches to avoid rate limiting
        if (i + batchSize < symbols.length) {
          await sleep(1000);
        }
      }
      
      // Sort results by entry time
      results.sort((a, b) => a.timestamp - b.timestamp);
      
      return results;
    } catch (error) {
      console.error("❌ Error processing entry times:", error);
      throw error;
    }
  }
}

module.exports = TradingStrategy;