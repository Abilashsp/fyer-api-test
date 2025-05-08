/* ------------------------------------------------------------------ */
/*  strategy.js – v5‑legacy (sig compat)                              */
/*  • Daily‑based core conditions                                     */
/*  • SMA‑based rules on dynamic intraday resolution                  */
/*  • updateRealtimeDataFromSF() restored for existing server code    */
/*  • Added TradeCard format support for UI integration                */
/* ------------------------------------------------------------------ */

const { EventEmitter } = require("events");
const moment       = require("moment");
const CandleDB = require("./candleDB");

/* Candle array indices */
const TIMESTAMP = 0, OPEN = 1, HIGH = 2, LOW = 3, CLOSE = 4, VOLUME = 5;

/* ---------- utils ------------------------------------------------- */
const SMA = (arr, n) =>
  arr.length < n ? null : arr.slice(-n).reduce((s, x) => s + x, 0) / n;

const rollup = (daily, mode) => {
  const map = new Map();
  daily.forEach((candle) => {
    const ts = candle[TIMESTAMP];
    const o = candle[OPEN];
    const h = candle[HIGH];
    const l = candle[LOW];
    const c = candle[CLOSE];
    const v = candle[VOLUME];
    
    const d   = moment.unix(ts);
    const key = mode === "W"
      ? `${d.isoWeek()}_${d.year()}`
      : `${d.year()}_${d.format("MM")}`;
      
    if (!map.has(key)) map.set(key, [ts, o, h, l, c, v]);
    else {
      const m = map.get(key);
      m[HIGH] = Math.max(m[HIGH], h);
      m[LOW] = Math.min(m[LOW], l);
      m[CLOSE] = c;
      m[VOLUME] += v;
    }
  });
  return Array.from(map.values()).sort((a, b) => a[TIMESTAMP] - b[TIMESTAMP]);
};

/* ---------- class ------------------------------------------------- */
class Strategy extends EventEmitter {
  /**
   * @param {TradingService} tradingService
   * @param {SocketIO.Server} io
   * @param {Object} opts
   *        opts.smaResolution – "1","5","60","120","240","D"
   *        opts.debug         – boolean
   */
  constructor(tradingService, io, opts = {}) {
    super();
    this.svc    = tradingService;
    this.io     = io;
    this.debug  = opts.debug ?? true;
    this.smaRes = opts.smaResolution ?? "60";

    this.dailyMap = new Map(); // symbol → daily candles[]
    this.smaMap   = new Map(); // symbol → SMA‑resolution candles[]
    this.state    = new Map(); // symbol → last analysis
    this.candleDB = tradingService.candleDB; // Reuse the same DB instance
    this.lastFetchDate = new Map(); // symbol → last fetch date
  }

  /* ---------------- public --------------------------------------- */
  getBullish() {
    return [...this.state.values()].filter(x => x.bullish).map(x => x.symbol);
  }

  /**
   * Get bullish signals in the format required by the React client and TradeCard component
   * @returns {Array} Array of objects with a 'trade' property containing the required data
   */
  getBullishSignals() {
    const bullishSymbols = this.getBullish();
    const signals = [];
    
    for (const symbol of bullishSymbols) {
      const data = this.state.get(symbol);
      if (!data) continue;
      
      // Extract symbol parts (e.g., "NSE:SBIN-EQ" -> exchange="NSE", symbol="SBIN")
      const parts = symbol.split(':');
      const exchange = parts[0] || 'NSE';
      const stockSymbol = parts.length > 1 ? parts[1].split('-')[0] : symbol;
      
      // Get daily data for price information
      const dailyData = this.dailyMap.get(symbol) || [];
      if (dailyData.length === 0) continue;
      
      const latestCandle = dailyData[dailyData.length - 1];
      const prevCandle = dailyData[dailyData.length - 2] || latestCandle;
      
      // Calculate price metrics
      const price = latestCandle[CLOSE]; // Close price
      const prevPrice = prevCandle[CLOSE];
      const change = price - prevPrice;
      const changePercentage = ((change / prevPrice) * 100).toFixed(2);
      
      // Create a trade object with the required format
      const trade = {
        key: symbol,
        symbol: stockSymbol,
        exchange: exchange,
        type: 'BUY',
        price: price.toFixed(2),
        change: change.toFixed(2),
        changePercentage: `${changePercentage}%`,
        entryPrice: price.toFixed(2),
        stopLoss: (price * 0.95).toFixed(2), // 5% below current price
        target: (price * 1.1).toFixed(2),    // 10% above current price
        liveReturns: '0.00%',
        estimatedGains: '10.00%',
        entryTime: moment.unix(latestCandle[TIMESTAMP]).format('HH:mm'),
        entryDate: moment.unix(latestCandle[TIMESTAMP]).format('DD-MM-YYYY'),
        isProfit: change >= 0
      };
      
      // Wrap the trade object in an object with a 'trade' property
      signals.push({ trade });
    }
    
    return signals;
  }
  
  getBearishSignals() {
    return []; // Placeholder for API compatibility
  }
  
  /**
   * Get the current SMA resolution used for analysis
   * @returns {string} Current resolution (e.g., "1", "5", "60", "120", "D")
   */
  getResolution() {
    return this.smaRes;
  }
  
  /**
   * Set a new SMA resolution for analysis and clear cached data
   * @param {string} resolution - New resolution to use
   * @returns {string} Normalized resolution that was set
   */
  setResolution(resolution) {
    // Normalize resolution format
    let res = String(resolution).toUpperCase().trim();
    
    // Apply the same normalization logic used in tradingService
    if (res === "240") res = "120";                         // 4H → 2H fallback
    if (/^\d+M$/i.test(res)) res = res.slice(0, -1);       // 15M → 15
    if (/^\d+H$/i.test(res)) res = String(parseInt(res) * 60); // 2H → 120
    if (res === "1D") res = "D";
    
    // Validate the resolution format
    if (res !== "D" && res !== "W" && res !== "M" && !/^\d+$/.test(res)) {
      throw new Error(`Invalid resolution format: ${resolution}`);
    }
    
    // Only change if different from current resolution
    if (res !== this.smaRes) {
      console.log(`Changing SMA resolution from ${this.smaRes} to ${res}`);
      this.smaRes = res;
      
      // Clear SMA data cache to force re-fetching with new resolution
      this.smaMap.clear();
      
      // If using database, check for cached data with new resolution
      if (this.useDatabase) {
        console.log(`Checking SQLite database for existing data with resolution ${res}`);
      }
    }
    
    return this.smaRes;
  }

  /** Legacy name kept for WebSocket tick handler */
  async updateRealtimeDataFromSF({ symbol, ltp }) {
    return this.tick(symbol, ltp);
  }

  /** Preferred shorter alias (also used internally) */
  async tick(symbol, ltp) {
    await this.#ensureDaily(symbol);
    await this.#ensureSMA(symbol);

    // live‑update today's candle so strategy stays up‑to‑date
    const daily = this.dailyMap.get(symbol);
    const dNow  = daily[daily.length - 1];
    const previousClose = dNow[CLOSE]; // Store previous close for comparison
    
    // Update the candle with the new price
    dNow[CLOSE] = ltp;
    if (ltp > dNow[HIGH]) dNow[HIGH] = ltp;
    if (ltp < dNow[LOW]) dNow[LOW] = ltp;
    
    // If using database, update the latest candle in SQLite too
    if (this.useDatabase) {
      // Store the updated candle in the database
      candleDB.storeCandles(symbol, "D", [dNow]);
    }

    // If significant price move, analyze immediately
    const priceChangePercent = Math.abs((ltp - previousClose) / previousClose * 100);
    const significantMove = priceChangePercent >= 0.5; // 0.5% price move threshold
    
    // Always analyze with priority for real-time signals
    await this.#analyze(symbol, significantMove);
  }

  /**
   * Analyze all symbols in the current dataset with the current resolution
   * Used when resolution changes to refresh signals
   * @returns {Promise<Array>} - Array of analysis results
   */
  async analyzeCurrentData() {
    const symbols = Array.from(this.dailyMap.keys());
    console.log(`Analyzing ${symbols.length} symbols with resolution ${this.smaRes}`);
    
    // If no symbols are loaded yet, return empty array
    if (symbols.length === 0) {
      return [];
    }
    
    // Get current prices from daily data for each symbol
    const results = [];
    
    // First ensure SMA data is loaded with current resolution
    for (const symbol of symbols) {
      // Clear existing SMA data to force refresh with new resolution
      this.smaMap.delete(symbol);
      // Load new SMA data with current resolution
      await this.#ensureSMA(symbol);
    }
    
    console.log(`🔍 Checking for bullish signals across all symbols...`);
    
    // Analyze each symbol
    for (const symbol of symbols) {
      const daily = this.dailyMap.get(symbol);
      // Use latest closing price for analysis
      const currentPrice = daily[daily.length - 1][CLOSE];
      await this.tick(symbol, currentPrice);
      
      // Keep track of analysis results
      const result = this.state.get(symbol);
      if (result) results.push(result);
    }
    
    // Count and log bullish symbols
    const bullishCount = results.filter(r => r.bullish).length;
    if (bullishCount > 0) {
      console.log(`🔔 Found ${bullishCount} bullish symbol(s)! UI will be updated immediately.`);
    } else {
      console.log(`No bullish symbols found in current analysis.`);
    }
    
    return results;
  }

  /* ---------------- internals ------------------------------------ */
  async #analyze(symbol, isPriorityCheck = false) {
    const daily = this.dailyMap.get(symbol);
    const smaData = this.smaMap.get(symbol);
    
    // Enhanced data sufficiency check
    if (!daily || !smaData) return;
    if (daily.length < 10) return; // Need at least 10 days of daily data

    // ---------- daily‑based core conditions ----------
    const today = daily.at(-1);
    const prev7 = daily.slice(-8, -1);
    
    // Check if today's range is greater than previous 7 days
    const rangeT = today[HIGH] - today[LOW];
    const rangeOK = prev7.every((candle) => rangeT > (candle[HIGH] - candle[LOW]));

    const closeGTopen = today[CLOSE] > today[OPEN];
    const closeGTyest = today[CLOSE] > prev7.at(-1)[CLOSE];
    const volYestOK = prev7.at(-1)[VOLUME] > 10_000;

    // Get weekly and monthly data from daily candles
    const wkBull = (() => {
      const w = rollup(daily, "W").at(-1);
      return w ? w[CLOSE] > w[OPEN] : false;
    })();
    
    const moBull = (() => {
      const m = rollup(daily, "M").at(-1);
      return m ? m[CLOSE] > m[OPEN] : false;
    })();

    // ---------- SMA conditions using cached values ----
    const smaOK = smaData.sma20 > smaData.sma50 && smaData.sma50 > smaData.sma200;

    // ---------- verdict --------------------------------
    const bullish = rangeOK && closeGTopen && closeGTyest &&
                    volYestOK && wkBull && moBull && smaOK;

    this.#diff(symbol, { 
      symbol, bullish, rangeOK, closeGTopen, closeGTyest,
      volYestOK, wkBull, moBull, smaOK, 
      s20: smaData.sma20, s50: smaData.sma50, s200: smaData.sma200,
      ma20_gt_ma200: smaData.sma20 > smaData.sma200,
      isPriorityCheck
    });
  }

  #diff(symbol, next) {
    const prev = this.state.get(symbol);
    this.state.set(symbol, next);
    
    // Determine if this is a real-time priority check
    const isPriorityCheck = next.isPriorityCheck || false;
    
    // Enhanced debugging - show which specific conditions are failing
    if (this.debug) {
      if (symbol.includes('AXISGOLD') || symbol.includes('NH')) {
        console.log(`--------- DETAILED DEBUG for ${symbol} ${isPriorityCheck ? '[PRIORITY]' : ''} ---------`);
        console.log(`rangeOK: ${next.rangeOK ? '✅' : '❌'}`);
        console.log(`closeGTopen: ${next.closeGTopen ? '✅' : '❌'}`);
        console.log(`closeGTyest: ${next.closeGTyest ? '✅' : '❌'}`);
        console.log(`volYestOK: ${next.volYestOK ? '✅' : '❌'}`);
        console.log(`wkBull: ${next.wkBull ? '✅' : '❌'}`);
        console.log(`moBull: ${next.moBull ? '✅' : '❌'}`);
        console.log(`smaOK: ${next.smaOK ? '✅' : '❌'}`);
        console.log(`SMA values - s20: ${next.s20}, s50: ${next.s50}, s200: ${next.s200}`);
        console.log(`Overall ${symbol}: ${next.bullish ? "✅" : "❌"}`);
        console.log(`-----------------------------------------`);
      } else {
        // Regular debug log for other symbols
        console.log(`${symbol}${isPriorityCheck ? ' [PRIORITY]' : ''}: ${next.bullish ? "✅" : "❌"}`);
      }
    }

    // For emitting a single bullish signal, we need to create a formatted trade object
    if (next.bullish && !prev?.bullish) {
      // Get daily data for price information to create trade object
      const dailyData = this.dailyMap.get(symbol) || [];
      if (dailyData.length > 0) {
        const latestCandle = dailyData[dailyData.length - 1];
        const prevCandle = dailyData[dailyData.length - 2] || latestCandle;
        
        // Extract symbol parts
        const parts = symbol.split(':');
        const exchange = parts[0] || 'NSE';
        const stockSymbol = parts.length > 1 ? parts[1].split('-')[0] : symbol;
        
        // Calculate price metrics
        const price = latestCandle[CLOSE]; // Close price
        const prevPrice = prevCandle[CLOSE];
        const change = price - prevPrice;
        const changePercentage = ((change / prevPrice) * 100).toFixed(2);
        
        // Create trade object
        const tradeSignal = {
          trade: {
            key: symbol,
            symbol: stockSymbol,
            exchange: exchange,
            type: 'BUY',
            price: price.toFixed(2),
            change: change.toFixed(2),
            changePercentage: `${changePercentage}%`,
            entryPrice: price.toFixed(2),
            stopLoss: (price * 0.95).toFixed(2),
            target: (price * 1.1).toFixed(2),
            liveReturns: '0.00%',
            estimatedGains: '10.00%',
            entryTime: moment.unix(latestCandle[0]).format('HH:mm'),
            entryDate: moment.unix(latestCandle[0]).format('DD-MM-YYYY'),
            isProfit: change >= 0
          }
        };
        
        // Emit both local event and socket.io event for UI updates
        this.emit("bullish", tradeSignal);
        
        // Force immediate UI update through socket.io
        if (this.io) {
          console.log(`🚨 BULLISH SIGNAL DETECTED for ${symbol}! Sending to UI immediately...`);
          this.io.emit("bullishSignal", tradeSignal);
          
          // Send a refresh event to ensure UI is updated
          this.io.emit("signalRefresh", { timestamp: Date.now() });
        }
      } else {
        // Fallback if no candle data available
        this.emit("bullish", next);
        
        // Force immediate UI update through socket.io
        if (this.io) {
          console.log(`🚨 BULLISH SIGNAL DETECTED for ${symbol}! Sending to UI immediately...`);
          this.io.emit("bullishSignal", { trade: { key: symbol, symbol, isProfit: true } });
          
          // Send a refresh event to ensure UI is updated
          this.io.emit("signalRefresh", { timestamp: Date.now() });
        }
      }
    }
    
    if (!next.bullish && prev?.bullish) {
      console.log(`❌ Symbol ${symbol} no longer bullish. Clearing signal.`);
      this.emit("clear", next);
      
      // Force immediate UI update for clearing signal
      if (this.io) {
        this.io.emit("clear", next);
        // Send a refresh event to ensure UI is updated
        this.io.emit("signalRefresh", { timestamp: Date.now() });
      }
    }
  }


  /* ---------- data‑fetch helpers -------------------- */
  async #ensureDaily(symbol) {
    const today = moment().format('YYYY-MM-DD');
    const lastFetch = this.lastFetchDate.get(symbol);

    // Check if we need to refresh data (new day or no data)
    const needsRefresh = !lastFetch || lastFetch !== today;

    if (!needsRefresh) {
      // Use cached data if we already fetched today
      if (!this.dailyMap.has(symbol)) {
        // Get from SQLite if not in memory
        const endTs = moment().unix();
        const startTs = moment().subtract(300, 'days').unix();
        const candles = this.candleDB.getDailyCandles(symbol, startTs, endTs);
        if (candles.length > 0) {
          this.dailyMap.set(symbol, candles);
        }
      }
      return;
    }

    // For new symbols or new day, check SQLite first
    const endTs = moment().unix();
    const startTs = moment().subtract(300, 'days').unix();
    const candles = this.candleDB.getDailyCandles(symbol, startTs, endTs);
    
    // Check if we have recent data (within last 24 hours)
    const hasRecentData = candles.length > 0 && 
      moment.unix(candles[candles.length - 1][0]).isAfter(moment().subtract(24, 'hours'));

    if (candles.length === 0 || !hasRecentData) {
      // Fetch from API if no data or data is old
      console.log(`🔄 Fetching daily data for ${symbol} from API (${!candles.length ? 'new symbol' : 'data refresh needed'})`);
      const { candles: apiCandles } = await this.svc.getHistoricalData(symbol, "D", 300);
      this.dailyMap.set(symbol, apiCandles);
      
      // Cache SMAs for common periods
      this.candleDB.cacheSMA(symbol, "D", 20, apiCandles);
      this.candleDB.cacheSMA(symbol, "D", 50, apiCandles);
      this.candleDB.cacheSMA(symbol, "D", 200, apiCandles);
    } else {
      this.dailyMap.set(symbol, candles);
    }
    
    // Update last fetch date
    this.lastFetchDate.set(symbol, today);
  }

  async #ensureSMA(symbol) {
    const today = moment().format('YYYY-MM-DD');
    const lastFetch = this.lastFetchDate.get(symbol);

    // Check if we need to refresh data (new day or no data)
    const needsRefresh = !lastFetch || lastFetch !== today;

    if (!needsRefresh) {
      // Use cached data if we already fetched today
      if (!this.smaMap.has(symbol)) {
        // Try to get SMA values from cache
        const sma20 = this.candleDB.getCachedSMA(symbol, this.smaRes, 20);
        const sma50 = this.candleDB.getCachedSMA(symbol, this.smaRes, 50);
        const sma200 = this.candleDB.getCachedSMA(symbol, this.smaRes, 200);

        if (sma20 && sma50 && sma200) {
          this.smaMap.set(symbol, {
            sma20: sma20.value,
            sma50: sma50.value,
            sma200: sma200.value
          });
        }
      }
      return;
    }

    // For new symbols or new day, check cache first
    const sma20 = this.candleDB.getCachedSMA(symbol, this.smaRes, 20);
    const sma50 = this.candleDB.getCachedSMA(symbol, this.smaRes, 50);
    const sma200 = this.candleDB.getCachedSMA(symbol, this.smaRes, 200);

    // Check if we have recent SMA data
    const hasRecentSMAs = sma20 && sma50 && sma200 && 
      moment.unix(sma20.ts).isAfter(moment().subtract(24, 'hours'));

    if (hasRecentSMAs) {
      // Use cached SMAs if they're recent
      this.smaMap.set(symbol, {
        sma20: sma20.value,
        sma50: sma50.value,
        sma200: sma200.value
      });
    } else {
      // Fetch new data if SMAs are missing or old
      console.log(`🔄 Fetching ${this.smaRes} data for ${symbol} from API (${!sma20 ? 'new symbol' : 'SMA refresh needed'})`);
      const { candles } = await this.svc.getHistoricalData(symbol, this.smaRes, 300);
      
      // Calculate and cache SMAs
      this.candleDB.cacheSMA(symbol, this.smaRes, 20, candles);
      this.candleDB.cacheSMA(symbol, this.smaRes, 50, candles);
      this.candleDB.cacheSMA(symbol, this.smaRes, 200, candles);
      
      // Store in memory
      this.smaMap.set(symbol, {
        sma20: this.candleDB.getCachedSMA(symbol, this.smaRes, 20).value,
        sma50: this.candleDB.getCachedSMA(symbol, this.smaRes, 50).value,
        sma200: this.candleDB.getCachedSMA(symbol, this.smaRes, 200).value
      });
    }
    
    // Update last fetch date
    this.lastFetchDate.set(symbol, today);
  }

  /**
   * Get cached SMA value
   * @param {string} symbol - Trading symbol
   * @param {number} period - SMA period
   * @returns {number|null} Cached SMA value or null if not found
   */
  getSMA(symbol, period) {
    const cached = this.candleDB.getCachedSMA(symbol, this.smaRes, period);
    return cached?.value || null;
  }
}

module.exports = Strategy;
