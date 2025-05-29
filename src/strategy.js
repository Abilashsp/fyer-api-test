/* ------------------------------------------------------------------ */
/*  strategy.js – v5-legacy (sig compat, SQLite cache, unique keys)   */
/* ------------------------------------------------------------------ */

const { EventEmitter } = require("events");
const moment           = require("moment");
const CandleDB         = require("./candleDB");

/* Candle array indices */
const T = 0, O = 1, H = 2, L = 3, C = 4, V = 5;

/* ---------- utils ------------------------------------------------- */
const SMA = (arr, n) =>
  arr.length < n ? null : arr.slice(-n).reduce((s, x) => s + x, 0) / n;

const rollup = (daily, mode) => {
  const m = new Map();
  daily.forEach(c => {
    const d = moment.unix(c[T]);
    const k = mode === "W" ? `${d.isoWeek()}_${d.year()}`
                           : `${d.year()}_${d.format("MM")}`;
    if (!m.has(k)) m.set(k, [...c]);
    else {
      const p = m.get(k);
      p[H] = Math.max(p[H], c[H]);
      p[L] = Math.min(p[L], c[L]);
      p[C] = c[C];
      p[V] += c[V];
    }
  });
  return [...m.values()].sort((a, b) => a[T] - b[T]);
};

/* ---------- class ------------------------------------------------- */
class Strategy extends EventEmitter {
  constructor(tradingService, io, opts = {}) {
    super();
    this.svc        = tradingService;
    this.io         = io;
    this.debug      = opts.debug ?? true;
    this.smaRes     = opts.smaResolution ?? "60";

    // Data structures to store candles and state
    this.dailyMap   = new Map();  // Daily candles: symbol → candles[]
    this.smaMap     = new Map();  // SMA values for current resolution: symbol → {sma20, sma50, sma200}
    this.state      = new Map();  // Strategy state: symbol → {bullish, ...}
    
    // SMA values for each specific resolution
    this.resolution1mSMA = new Map();  // 1-minute SMA values
    this.resolution5mSMA = new Map();  // 5-minute SMA values
    this.resolution60mSMA = new Map(); // 60-minute SMA values
    this.resolution120mSMA = new Map(); // 120-minute SMA values
    this.resolutionDSMA = new Map();   // Daily SMA values

    /* ---- FIX: always fall back to module ---------------------- */
    this.candleDB   = tradingService.candleDB ?? CandleDB;

    this.lastFetch  = new Map();           // symbol → YYYY-MM-DD
  }

  /* ---- helper: unique key per symbol+resolution ---------------- */
  #makeKey(sym) { return `${sym}@${this.smaRes}`; }

  /* ---------------- public helpers ----------------------------- */
  getBullish() { return [...this.state.values()].filter(r => r.bullish).map(r => r.symbol); }
  getBearishSignals() { return []; }
  getResolution() { return this.smaRes; }

  getBullishSignals() {
    const out = [];
    for (const symbol of this.getBullish()) {
      const daily = this.dailyMap.get(symbol);
      if (!daily?.length) continue;

      const latest = daily.at(-1);
      const prev   = daily.at(-2) || latest;
      const price  = latest[C];
      const diff   = price - prev[C];
      const pct    = ((diff / prev[C]) * 100).toFixed(2);

      const [exch, codeRaw] = symbol.split(":");
      const stock = codeRaw ? codeRaw.split("-")[0] : symbol;

      out.push({
        trade: {
          key: this.#makeKey(symbol),
          resolution: this.smaRes,
          symbol: stock,
          exchange: exch || "NSE",
          type: "BUY",
          price: price.toFixed(2),
          change: diff.toFixed(2),
          changePercentage: `${pct}%`,
          entryPrice: price.toFixed(2),
          stopLoss: (price * 0.95).toFixed(2),
          target: (price * 1.10).toFixed(2),
          liveReturns: "0.00%",
          estimatedGains: "10.00%",
          entryTime: moment.unix(latest[T]).format("HH:mm"),
          entryDate: moment.unix(latest[T]).format("DD-MM-YYYY"),
          isProfit: diff >= 0
        }
      });
    }
    return out;
  }

  /* ---------------- resolution management ---------------------- */
  setResolution(res) {
    let r = String(res).toUpperCase().trim();
    if (r === "240") r = "120";
    if (/^\d+M$/i.test(r)) r = r.slice(0, -1);
    if (/^\d+H$/i.test(r)) r = String(parseInt(r) * 60);
    if (r === "1D") r = "D";
    if (r !== "D" && r !== "W" && r !== "M" && !/^\d+$/.test(r))
      throw new Error(`Invalid resolution: ${res}`);

    if (r !== this.smaRes) {
      console.log(`Changing SMA resolution ${this.smaRes} → ${r}`);
      this.smaRes = r;
      this.smaMap.clear();
    }
    return this.smaRes;
  }

  /* legacy alias -------------------------------------------------- */
  async updateRealtimeDataFromSF({ symbol, ltp }) { return this.tick(symbol, ltp); }

  /* ---------------- live tick ----------------------------------- */
  async tick(symbol, ltp) {
    await this.#ensureDaily(symbol);
    await this.#ensureSMA(symbol);

    const daily = this.dailyMap.get(symbol);
    const tdy   = daily.at(-1);
    const prevC = tdy[C];

    tdy[C] = ltp;
    if (ltp > tdy[H]) tdy[H] = ltp;
    if (ltp < tdy[L]) tdy[L] = ltp;

    this.candleDB.storeCandles(symbol, "D", [tdy]);

    const pct = Math.abs((ltp - prevC) / prevC * 100);
    await this.#analyze(symbol, pct >= 0.5);
  }

  /* ---------------- history loaders ---------------------------- */
  async #ensureDaily(symbol) {
    const today = moment().format("YYYY-MM-DD");
    if (this.lastFetch.get(`${symbol}_D`) === today && this.dailyMap.has(symbol)) return;

    const endTs   = moment().unix();
    const startTs = moment().subtract(300, "days").unix();
    let candles   = this.candleDB.getCandles(symbol, "D", startTs, endTs);

    if (!candles.length || !moment.unix(candles.at(-1)[T]).isSame(today, "day")) {
      const { candles: api } = await this.svc.getHistoricalData(symbol, "D", 300);
      candles = api;
      this.candleDB.storeCandles(symbol, "D", api);
    }
    this.dailyMap.set(symbol, candles);
    this.lastFetch.set(`${symbol}_D`, today);
  }

  async #ensureSMA(symbol) {
    const tag   = `${symbol}_${this.smaRes}`;
    const today = moment().format("YYYY-MM-DD");
    
    // Return early if we already have current data in memory for current resolution
    // This is our first cache check - memory cache
    if (this.lastFetch.get(tag) === today && this.smaMap.has(symbol)) {
      console.log(`Using memory-cached SMA values for ${symbol} @ ${this.smaRes}`);
      return;
    }

    // Try to get SMA values directly from the database view (most efficient)
    try {
      // This uses our optimized view-based query
      const allSMAs = this.candleDB.getAllSMA(symbol, this.smaRes);
      if (allSMAs.sma20 !== null && allSMAs.sma50 !== null && allSMAs.sma200 !== null) {
        // We have all the values we need in the database
        this.smaMap.set(symbol, {
          sma20 : allSMAs.sma20,
          sma50 : allSMAs.sma50,
          sma200: allSMAs.sma200
        });
        console.log(`Using database-cached SMA values for ${symbol} @ ${this.smaRes}`);
        this.lastFetch.set(tag, today);
        
        // Now ensure we have SMA values for all key timeframes
        // But we'll use a non-API fetching approach when possible
        await this.#ensureAllTimeframeSMAs(symbol, true); // true = prioritize cache
        return;
      }
    } catch (err) {
      console.warn(`Error getting cached SMA values: ${err.message}`);
    }
    
    // Fallback to individual SMA queries if the view approach failed
    const sma20  = this.candleDB.getCachedSMA(symbol, this.smaRes, 20);
    const sma50  = this.candleDB.getCachedSMA(symbol, this.smaRes, 50);
    const sma200 = this.candleDB.getCachedSMA(symbol, this.smaRes, 200);
    
    // Check if all SMAs are available for current resolution
    const allSmasAvailable = sma20?.value && sma50?.value && sma200?.value;
    
    if (allSmasAvailable) {
      // We have all the values from individual queries
      this.smaMap.set(symbol, {
        sma20 : sma20.value,
        sma50 : sma50.value,
        sma200: sma200.value
      });
      console.log(`Using individual cached SMA values for ${symbol} @ ${this.smaRes}`);
      this.lastFetch.set(tag, today);
      
      // Now ensure we have SMA values for all key timeframes
      await this.#ensureAllTimeframeSMAs(symbol, true); // true = prioritize cache
      return;
    }
    
    // If we get here, we need to fetch new data from the API
    console.log(`Fetching new candles for ${symbol} @ ${this.smaRes} (missing SMAs in cache)`);
    try {
      const { candles } = await this.svc.getHistoricalData(symbol, this.smaRes, 300);
      
      // Cache the new candles with SMA calculations
      if (candles && candles.length > 0) {
        this.candleDB.cacheSMA(symbol, this.smaRes, 20, candles);
        this.candleDB.cacheSMA(symbol, this.smaRes, 50, candles);
        this.candleDB.cacheSMA(symbol, this.smaRes, 200, candles);
        
        // Get the updated SMA values from the database
        const updatedSMAs = this.candleDB.getAllSMA(symbol, this.smaRes);
        this.smaMap.set(symbol, {
          sma20 : updatedSMAs.sma20,
          sma50 : updatedSMAs.sma50,
          sma200: updatedSMAs.sma200
        });
      } else {
        console.warn(`No candles returned for ${symbol} @ ${this.smaRes}`);
      }
    } catch (fetchErr) {
      console.error(`Error fetching candles for ${symbol} @ ${this.smaRes}: ${fetchErr.message}`);
    }
    
    this.lastFetch.set(tag, today);
    
    // Now ensure we have SMA values for all key timeframes
    await this.#ensureAllTimeframeSMAs(symbol, true); // true = prioritize cache
  }
  
  async #ensureAllTimeframeSMAs(symbol) {
    const today = moment().format("YYYY-MM-DD");
    const tag = `${symbol}_allTimeframes`;
    
    // Skip if we already have current data for all timeframes
    if (this.lastFetch.get(tag) === today && 
        this.resolution1mSMA.has(symbol) && 
        this.resolution5mSMA.has(symbol) && 
        this.resolution60mSMA.has(symbol) && 
        this.resolution120mSMA.has(symbol) && 
        this.resolutionDSMA.has(symbol)) {
      console.log(`Using cached SMA values for ${symbol} across all timeframes`);
      return;
    }
    
    // Attempt to get all SMA values from the database views
    try {
      console.log(`Fetching all timeframe SMA values for ${symbol} from database views...`);
      
      // Use the new optimized method that queries all timeframes at once
      const allTimeframeSMAs = this.candleDB.getAllTimeframeSMAs(symbol);
      
      // Check if we have all SMA values for all resolutions
      const allAvailable = Object.values(allTimeframeSMAs).every(sma => 
        sma.sma20 !== null && sma.sma50 !== null && sma.sma200 !== null
      );
      
      if (allAvailable) {
        // Store values in the maps
        this.resolution1mSMA.set(symbol, allTimeframeSMAs['1']);
        this.resolution5mSMA.set(symbol, allTimeframeSMAs['5']);
        this.resolution60mSMA.set(symbol, allTimeframeSMAs['60']);
        this.resolution120mSMA.set(symbol, allTimeframeSMAs['120']);
        this.resolutionDSMA.set(symbol, allTimeframeSMAs['D']);
        
        console.log(`Got all SMA values for ${symbol} from database views`);
        this.lastFetch.set(tag, today);
        return;
      }
      
      console.log(`Some SMA values missing for ${symbol}, fetching candles...`);
    } catch (err) {
      console.error(`Error fetching SMA values for ${symbol} from views: ${err.message}`);
    }
    
    // If we couldn't get all values from the views, fetch candles for the missing ones
    const timeframes = [
      { res: "1", map: this.resolution1mSMA },     // 1-minute
      { res: "5", map: this.resolution5mSMA },     // 5-minute
      { res: "60", map: this.resolution60mSMA },   // 60-minute (1-hour)
      { res: "120", map: this.resolution120mSMA }, // 120-minute (2-hour)
      { res: "D", map: this.resolutionDSMA }       // Daily
    ];
    
    for (const { res, map } of timeframes) {
      const timeframeTag = `${symbol}_${res}`;
      
      // Skip if we already have current data for this timeframe
      if (this.lastFetch.get(timeframeTag) === today && map.has(symbol)) continue;
      
      // Check if we have SMAs for this timeframe using the new view-based method
      const smaValues = this.candleDB.getAllSMA(symbol, res);
      const allSmasAvailable = smaValues.sma20 !== null && smaValues.sma50 !== null && smaValues.sma200 !== null;
      
      if (allSmasAvailable) {
        // Use the values from the view
        map.set(symbol, {
          sma20: smaValues.sma20,
          sma50: smaValues.sma50,
          sma200: smaValues.sma200
        });
        console.log(`Using SMA values from view for ${symbol} @ ${res}`);
        this.lastFetch.set(timeframeTag, today);
        continue;
      }
      
      // We need to fetch candles and calculate SMAs
      console.log(`Fetching candles for ${symbol} @ ${res} (missing SMAs in cache)`);
      
      // Determine appropriate candle count based on timeframe
      // Remember Fyers API limits: 1-15m (30 days), 30-60m (180 days), 120m (180 days), D+ (365 days)
      let lookback = 300;
      
      // For 1m and 5m, we need enough data for SMA calculations. Fyers allows max 30 days for 1-15m
      if (res === "1") {
        lookback = 2000; // ~33 hours (at least SMA20 + some buffer - Fyers may limit further)
        console.log(`${symbol} @ ${res}: Using lookback=${lookback} (needed for SMA calculations)`);
      } 
      else if (res === "5") {
        lookback = 2000; // ~166 hours/~7 days (provides sufficient data for SMA200)
        console.log(`${symbol} @ ${res}: Using lookback=${lookback} (needed for SMA calculations)`);
      }
      else if (res === "60") lookback = 800; // ~33 days (sufficient for SMA50, nearing max for SMA200)
      else if (res === "120") lookback = 800; // ~66 days (sufficient for SMA200)
      else if (res === "D") lookback = 365;  // Daily: ~1 year (sufficient for SMA20, SMA50, SMA200)
      
      try {
        const { candles } = await this.svc.getHistoricalData(symbol, res, lookback);
        
        if (candles && candles.length > 0) {
          this.candleDB.cacheSMA(symbol, res, 20, candles);
          this.candleDB.cacheSMA(symbol, res, 50, candles);
          this.candleDB.cacheSMA(symbol, res, 200, candles);
          
          // Get the updated SMA values using the optimized method
          const updatedSMAs = this.candleDB.getAllSMA(symbol, res);
          map.set(symbol, {
            sma20: updatedSMAs.sma20,
            sma50: updatedSMAs.sma50,
            sma200: updatedSMAs.sma200
          });
          
          console.log(`Stored SMA values for ${symbol} @ ${res}`);
        } else {
          console.warn(`No candles returned for ${symbol} @ ${res}`);
        }
      } catch (err) {
        console.error(`Error fetching candles for ${symbol} @ ${res}: ${err.message}`);
      }
      
      this.lastFetch.set(timeframeTag, today);
    }
    
    // Update the overall tag if we have all values
    if (this.resolution1mSMA.has(symbol) && 
        this.resolution5mSMA.has(symbol) && 
        this.resolution60mSMA.has(symbol) && 
        this.resolution120mSMA.has(symbol) && 
        this.resolutionDSMA.has(symbol)) {
      this.lastFetch.set(tag, today);
    }
  }

  /* ---------------- analysis ----------------------------------- */
  async #analyze(symbol, isPriority = false) {
    const daily = this.dailyMap.get(symbol);
    const smaBuf = this.smaMap.get(symbol);
    if (!daily || daily.length < 10 || !smaBuf) {
      if (this.debug) {
        console.log(`${symbol}: Not enough data for analysis (daily: ${daily?.length || 0}, smaBuf: ${!!smaBuf})`);
      }
      return;
    }

    // Get the latest candle and previous 7 days
    const today = daily.at(-1);
    const todayRange = today[H] - today[L]; // Today's high-low range

    // Check individual range comparisons against previous 7 days
    // (Daily High - Daily Low) greater than (n days ago High - n days ago Low)
    const rangeComparisons = [];
    for (let i = 1; i <= 7; i++) {
      if (daily.length < i + 1) continue; // Skip if we don't have enough data
      
      const prevCandle = daily.at(-1 - i);
      const prevRange = prevCandle[H] - prevCandle[L];
      rangeComparisons.push({
        day: i,
        today: todayRange,
        prev: prevRange,
        result: todayRange > prevRange
      });
    }
    
    // Must pass all range comparisons
    const rangeOK = rangeComparisons.every(comp => comp.result);

    // Daily Close greater than Daily Open
    const closeGTopen = today[C] > today[O];
    
    // Daily Close greater than 1 day ago Close
    const closeGTyest = today[C] > daily.at(-2)[C];
    
    // 1 day ago Volume greater than 10000
    const volYestOK = daily.at(-2)[V] > 10_000;
    
    // Weekly Close greater than Weekly Open
    const weeklyData = rollup(daily, "W");
    const wkBull = weeklyData.length > 0 && weeklyData.at(-1)[C] > weeklyData.at(-1)[O];
    
    // Monthly Close greater than Monthly Open
    const monthlyData = rollup(daily, "M");
    const moBull = monthlyData.length > 0 && monthlyData.at(-1)[C] > monthlyData.at(-1)[O];

    // ==== Multi-timeframe SMA Analysis ==== //
    // Check if we have SMA values for all timeframes
    const sma1m = this.resolution1mSMA.get(symbol);
    const sma5m = this.resolution5mSMA.get(symbol);
    const sma60m = this.resolution60mSMA.get(symbol);
    const sma120m = this.resolution120mSMA.get(symbol);
    const smaD = this.resolutionDSMA.get(symbol);
    
    // Create an object to store SMA conditions for each timeframe
    const smaConds = {};
    
    // Check 1-minute SMA condition: SMA20 > SMA50 > SMA200
    smaConds.minute1 = sma1m && sma1m.sma20 > sma1m.sma50 && sma1m.sma50 > sma1m.sma200;
    
    // Check 5-minute SMA condition: SMA20 > SMA50 > SMA200
    smaConds.minute5 = sma5m && sma5m.sma20 > sma5m.sma50 && sma5m.sma50 > sma5m.sma200;
    
    // Check 60-minute SMA condition: SMA20 > SMA50 > SMA200
    smaConds.minute60 = sma60m && sma60m.sma20 > sma60m.sma50 && sma60m.sma50 > sma60m.sma200;
    
    // Check 120-minute SMA condition: SMA20 > SMA50 > SMA200
    smaConds.minute120 = sma120m && sma120m.sma20 > sma120m.sma50 && sma120m.sma50 > sma120m.sma200;
    
    // Check Daily SMA condition: SMA20 > SMA50 > SMA200
    smaConds.daily = smaD && smaD.sma20 > smaD.sma50 && smaD.sma50 > smaD.sma200;
    
    // SMA conditions using cached values from database for current resolution
    const { sma20:s20, sma50:s50, sma200:s200 } = smaBuf;
    
    // Daily SMA(close, 20) greater than Daily SMA(close, 50)
    // Daily SMA(close, 50) greater than Daily SMA(close, 200)
    const smaOK = s20 > s50 && s50 > s200;
    
    // Count how many timeframes show bullish SMA pattern
    const bullishTimeframes = Object.values(smaConds).filter(Boolean).length;
    
    // Check if the shorter timeframes (1m and 5m) have valid data
    const shortFramesValid = (sma1m !== undefined && sma5m !== undefined);
    
    // Check if at least one of the short timeframes is bullish (if we have valid data)
    const shortTimeframesBullish = shortFramesValid ? 
      (smaConds.minute1 || smaConds.minute5) : true; // If no data, consider as neutral (not negative)
    
    // All conditions must be true, including at least one short timeframe if data is available
    const bullish =
      rangeOK && closeGTopen && closeGTyest &&
      volYestOK && wkBull && moBull && smaOK && 
      shortTimeframesBullish; // Require at least one short timeframe to be bullish if data exists
    
    // Debug output for each condition
    if (this.debug && isPriority) {
      console.log(`\n--- ${symbol} Strategy Analysis ---`);
      console.log(`Range comparisons:`);
      rangeComparisons.forEach(comp => {
        console.log(`  Day -${comp.day}: Today(${comp.today.toFixed(2)}) > Prev(${comp.prev.toFixed(2)}) = ${comp.result ? '✅' : '❌'}`);
      });
      console.log(`Close > Open: ${closeGTopen ? '✅' : '❌'}`);
      console.log(`Close > Yesterday Close: ${closeGTyest ? '✅' : '❌'}`);
      console.log(`Yesterday Vol > 10k: ${volYestOK ? '✅' : '❌'} (${daily.at(-2)[V].toFixed(0)})`);
      console.log(`Weekly Bullish: ${wkBull ? '✅' : '❌'}`);
      console.log(`Monthly Bullish: ${moBull ? '✅' : '❌'}`);
      
      // SMA debugging for all timeframes
      console.log(`\nSMA Analysis by Timeframe:`);
      if (sma1m) console.log(`  1m: SMA20(${sma1m.sma20?.toFixed(2)}) > SMA50(${sma1m.sma50?.toFixed(2)}) > SMA200(${sma1m.sma200?.toFixed(2)}): ${smaConds.minute1 ? '✅' : '❌'}`);
      else console.log(`  1m: No data`);
      
      if (sma5m) console.log(`  5m: SMA20(${sma5m.sma20?.toFixed(2)}) > SMA50(${sma5m.sma50?.toFixed(2)}) > SMA200(${sma5m.sma200?.toFixed(2)}): ${smaConds.minute5 ? '✅' : '❌'}`);
      else console.log(`  5m: No data`);
      
      if (sma60m) console.log(`  60m: SMA20(${sma60m.sma20?.toFixed(2)}) > SMA50(${sma60m.sma50?.toFixed(2)}) > SMA200(${sma60m.sma200?.toFixed(2)}): ${smaConds.minute60 ? '✅' : '❌'}`);
      else console.log(`  60m: No data`);
      
      if (sma120m) console.log(`  120m: SMA20(${sma120m.sma20?.toFixed(2)}) > SMA50(${sma120m.sma50?.toFixed(2)}) > SMA200(${sma120m.sma200?.toFixed(2)}): ${smaConds.minute120 ? '✅' : '❌'}`);
      else console.log(`  120m: No data`);
      
      if (smaD) console.log(`  D: SMA20(${smaD.sma20?.toFixed(2)}) > SMA50(${smaD.sma50?.toFixed(2)}) > SMA200(${smaD.sma200?.toFixed(2)}): ${smaConds.daily ? '✅' : '❌'}`);
      else console.log(`  D: No data`);
      
      console.log(`Current Resolution (${this.smaRes}): SMA20(${s20?.toFixed(2)}) > SMA50(${s50?.toFixed(2)}) > SMA200(${s200?.toFixed(2)}): ${smaOK ? '✅' : '❌'}`);
      console.log(`Bullish Timeframes: ${bullishTimeframes} of ${Object.keys(smaConds).length}`);
      console.log(`Overall result: ${bullish ? '✅ BULLISH' : '❌ NOT BULLISH'}`);
    }

    this.#diff(symbol, {
      symbol,
      bullish,
      rangeOK,
      closeGTopen,
      closeGTyest,
      volYestOK,
      wkBull,
      moBull,
      smaOK,
      s20,
      s50,
      s200,
      ma20_gt_ma200: s20 > s200,
      isPriorityCheck: isPriority
    });
  }

  /* ---------------- diff / emit --------------------------------- */
  #diff(symbol, next) {
    const prev = this.state.get(symbol);
    this.state.set(symbol, next);

    if (this.debug) {
      console.log(
        `${symbol}${next.isPriorityCheck ? " [PRIORITY]" : ""}: ${
          next.bullish ? "✅" : "❌"
        }`
      );
    }

    /* --------- new bullish ------------------------------------- */
    if (next.bullish && !prev?.bullish) {
      const daily = this.dailyMap.get(symbol);
      const latest = daily.at(-1);
      const prevC  = daily.at(-2) || latest;
      const price  = latest[C];
      const diff   = price - prevC[C];
      const pct    = ((diff / prevC[C]) * 100).toFixed(2);
      const [exch, codeRaw] = symbol.split(":");
      const stock = codeRaw ? codeRaw.split("-")[0] : symbol;

      const payload = {
        trade: {
          key: this.#makeKey(symbol),
          resolution: this.smaRes,
          symbol: stock,
          exchange: exch || "NSE",
          type: "BUY",
          price: price.toFixed(2),
          change: diff.toFixed(2),
          changePercentage: `${pct}%`,
          entryPrice: price.toFixed(2),
          stopLoss: (price * 0.95).toFixed(2),
          target: (price * 1.10).toFixed(2),
          liveReturns: "0.00%",
          estimatedGains: "10.00%",
          entryTime: moment.unix(latest[T]).format("HH:mm"),
          entryDate: moment.unix(latest[T]).format("DD-MM-YYYY"),
          isProfit: diff >= 0
        }
      };

      this.emit("bullish", payload);
      this.io?.emit("bullishSignal", payload);
      this.io?.emit("signalRefresh", { ts: Date.now() });
    }

    /* --------- clear ------------------------------------------- */
    if (!next.bullish && prev?.bullish) {
      const payload = { key: this.#makeKey(symbol) };
      this.emit("clear", payload);
      this.io?.emit("clear", payload);
      this.io?.emit("signalRefresh", { ts: Date.now() });
    }
  }

  /* ------------- analyzeCurrentData (UI refresh) ---------------- */
  async analyzeCurrentData() {
    const symbols = [...this.dailyMap.keys()];
    if (!symbols.length) return [];

    for (const s of symbols) {
      this.smaMap.delete(s);
      await this.#ensureSMA(s);
    }

    const results = [];
    for (const s of symbols) {
      const close = this.dailyMap.get(s).at(-1)[C];
      await this.tick(s, close);
      results.push(this.state.get(s));
    }
    return results;
  }
}

module.exports = Strategy;
