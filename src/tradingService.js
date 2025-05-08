/* ------------------------------------------------------------------ */
/*  tradingService.js – Fyers API v3 (Unix timestamps, multi-timeframe) */
/* ------------------------------------------------------------------ */
const { fyersModel } = require("fyers-api-v3");
const authManager    = require("./auth2.0");
const moment         = require("moment");
const path           = require("path");
const dotenv         = require("dotenv");
const CandleDB       = require("./candleDB");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

/* Helper functions */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Intraday look-back caps (calendar days)                            */
/* ------------------------------------------------------------------ */
function maxDaysFor(resMin) {
  if (resMin <= 15)  return 30;    // 1–15 min
  if (resMin <= 60)  return 180;   // 30 & 60 min
  if (resMin <= 120) return 180;   // 120 min
  return 365;                      // daily+
}

class RateLimiter {
  constructor(maxPerMin = 8) {
    this.max    = maxPerMin;
    this.tokens = maxPerMin;
    this.last   = Date.now();
    this.rate   = maxPerMin / 60; // tokens per sec
  }
  
  async wait() {
    this._refill();
    if (this.tokens < 1) {
      const wait = Math.ceil((1 / this.rate) * 1000);
      console.log(`⏳ rate-limit – waiting ${wait} ms`);
      await sleep(wait);
      return this.wait();
    }
    this.tokens -= 1;
  }
  
  _refill() {
    const add = ((Date.now() - this.last) / 1000) * this.rate;
    if (add > 0) {
      this.tokens = Math.min(this.max, this.tokens + add);
      this.last   = Date.now();
    }
  }
}

class TradingService {
  constructor() {
    this.fyers     = null;
    this.limiter   = new RateLimiter(8);
    this.cache     = new Map();          // key → {ts,data} (in-memory cache)
    this.cacheTTL  = 5 * 60_000;
    this.lastCall  = 0;
    this.candleDB  = new CandleDB(path.join(__dirname, '../data/candles.db'));
  }

  /* ---------- bootstrap ------------------------------------------ */
  async initialize() {
    if (!this.fyers) {
      await authManager.initialize();
      let token = await authManager.getAccessToken();
      if (!token) token = await authManager.authenticate();
      if (!token) throw new Error('Failed to get access token');

      console.log("🔑 using token:", token.slice(0, 30) + "…");
      this.fyers = new fyersModel({
        path: path.resolve(__dirname, '../logs'),
        enableLogging: true
      });
      this.fyers.setAppId(process.env.FYERS_APP_ID);
      this.fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);
      this.fyers.setAccessToken(token);

      try {
        const profile = await this.fyers.get_profile();
        if (!profile || profile.s !== 'ok') throw new Error('Profile validation failed');
        console.log('✅ Fyers client initialized successfully');
      } catch (err) {
        console.error('❌ Fyers client validation failed:', err);
        throw err;
      }
    }
    return this;
  }

  /* ---------- internal fetch with retries ------------------------ */
  async _fetch(params, sym, resStr, want, retry = 0) {
    const resMin  = /^\d+$/.test(resStr) ? Number(resStr) : null;
    const isIntra = !!resMin;
    const limitD  = isIntra ? maxDaysFor(resMin) : 365;

    if (retry > 3) {
      console.warn(`⚠️ max retries ${sym}@${resStr}`);
      return { success: false, candles: [] };
    }

    try {
      // Handle date_format conversion for API params
      const originalParams = { ...params };
      
      // Convert YYYY-MM-DD format to Unix timestamp if needed for API request
      if (params.date_format === "1") {
        // Keep the original params for recursive calls
        if (params.range_from && !isNaN(Number(params.range_from))) {
          // Already in timestamp format, no conversion needed
        } else if (params.range_from) {
          const fromMoment = moment(params.range_from, 'YYYY-MM-DD');
          if (fromMoment.isValid()) {
            params.range_from = String(fromMoment.unix());
          }
        }
        
        if (params.range_to && !isNaN(Number(params.range_to))) {
          // Already in timestamp format, no conversion needed
        } else if (params.range_to) {
          const toMoment = moment(params.range_to, 'YYYY-MM-DD');
          if (toMoment.isValid()) {
            params.range_to = String(toMoment.unix());
          }
        }
        
        // Change date_format to 0 for API request
        params.date_format = "0";
      }
      
      const resp = await this.fyers.getHistory(params);
      if (!resp || resp.s !== "ok" || !Array.isArray(resp.candles))
        throw new Error(resp?.s || "API error");

      const candles = resp.candles;
      if (candles.length >= want || !isIntra)
        return { success: true, candles };

      /* expand but stay inside maxDaysFor window ------------------ */
      const earliest = moment().subtract(limitD, "days").unix();
      let span, nextFrom;
      
      // Calculate span and nextFrom based on date format
      if (originalParams.date_format === "1") {
        // Use the original date strings for calculating the next range
        const fromMoment = moment(originalParams.range_from, 'YYYY-MM-DD');
        const toMoment = moment(originalParams.range_to, 'YYYY-MM-DD');
        
        if (!fromMoment.isValid() || !toMoment.isValid()) {
          throw new Error(`Invalid date format: ${originalParams.range_from} → ${originalParams.range_to}`);
        }
        
        span = toMoment.diff(fromMoment, 'days');
        const newFromMoment = fromMoment.subtract(span * (retry + 1), 'days');
        
        if (newFromMoment.unix() <= earliest) {
          return { success: true, candles };
        }
        
        // Restore original format for recursive call
        originalParams.range_from = newFromMoment.format('YYYY-MM-DD');
        await sleep(1000 * 2 ** retry);
        return this._fetch(originalParams, sym, resStr, want, retry + 1);
      } else {
        // Original Unix timestamp format
        span = Number(params.range_to) - Number(params.range_from);
        nextFrom = Number(params.range_from) - span * (retry + 1);
        
        if (nextFrom <= earliest) {
          return { success: true, candles };
        }
        
        params.range_from = String(nextFrom);
        await sleep(1000 * 2 ** retry);
      }
      
      const moreData = await this._fetch(params, sym, resStr, want, retry + 1);
      
      if (moreData.success && moreData.candles.length > 0) {
        // Combine the candles, removing duplicates
        const existingTimestamps = new Set(candles.map(c => c[0]));
        const newCandles = moreData.candles.filter(c => !existingTimestamps.has(c[0]));
        return { success: true, candles: [...candles, ...newCandles].sort((a, b) => a[0] - b[0]) };
      }
      
      return { success: true, candles };
    } catch (err) {
      console.error(`❌ fetch ${sym}@${resStr}: ${err.message}`);
      await sleep(1000 * 2 ** retry);
      return this._fetch(params, sym, resStr, want, retry + 1);
    }
  }

  /* ---------- public: getHistoricalData -------------------------- */
  async getHistoricalData(symbol, resolution = "D", lookback = 365) {
    /* 1. normalise resolution ----------------------------------- */
    let res = String(resolution).toUpperCase().trim();

    if (res === "240") res = "120";                // ← 4-h fallback
    if (/^\d+M$/i.test(res)) res = res.slice(0, -1);           // 15M→15
    if (/^\d+H$/i.test(res)) res = String(parseInt(res) * 60); // 2H→120
    if (res === "1D") res = "D";
    if (res !== "D" && res !== "W" && res !== "M" && !/^\d+$/.test(res))
      throw new Error(`Bad resolution: ${resolution}`);
    
    // Handle weekly and monthly by rolling up daily data
    if (res === "W" || res === "M") {
      const days  = res === "W" ? lookback * 7 : lookback * 31;
      const daily = await this.getHistoricalData(symbol, "D", days);
      return { success: daily.success, candles: this._rollup(daily.candles, res) };
    }

    /* 2. rate-limit -------------------------------------------- */
    await this.limiter.wait();
    const lag = Date.now() - this.lastCall;
    if (lag < 500) await sleep(500 - lag);
    this.lastCall = Date.now();

    /* 3. figure look-back window -------------------------------- */
    const WANT    = 200;
    const resMin  = res === "D" ? 1440 : Number(res);
    const dayMin  = 6.5 * 60;
    let backDays  = Math.ceil((WANT * resMin) / dayMin) * 1.3;
    backDays      = Math.min(backDays, maxDaysFor(resMin));

    const end   = moment().unix();
    const start = moment().subtract(backDays, "days").unix();

    /* 4. in-memory cache first ----------------------------------- */
    const key = `${symbol}_${res}_${start}_${end}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheTTL) return hit.data;

    /* 5. Check SQLite cache for daily data ---------------------- */
    if (res === "D" && !this.candleDB.needsUpdate(symbol)) {
      const candles = this.candleDB.getDailyCandles(symbol, start, end);
      if (candles.length > 0) {
        const result = { success: true, candles };
        this.cache.set(key, { ts: Date.now(), data: result });
        return result;
      }
    }

    /* 6. build params & fetch all data if needed ----------------- */
    const p = {
      symbol,
      resolution : res,
      date_format: "1",     // Use YYYY-MM-DD format as per memory note
      range_from : moment.unix(start).format('YYYY-MM-DD'),
      range_to   : moment.unix(end).format('YYYY-MM-DD'),
      cont_flag  : "1",
    };

    console.log(`📈 ${symbol}@${res} ${moment.unix(start).format("YYYY-MM-DD")} → ${moment.unix(end).format("YYYY-MM-DD")}`);
    const result = await this._fetch(p, symbol, res, WANT);
    
    // Cache in both memory and SQLite
    this.cache.set(key, { ts: Date.now(), data: result });
    if (res === "D") {
      this.candleDB.storeDailyCandles(symbol, result.candles);
    }
    
    return result;
  }
  
  /* ---------- Helper: roll up daily data to weekly/monthly ------- */
  _rollup(daily, mode) {
    if (!daily || daily.length === 0) return [];
    
    const map = new Map();
    daily.forEach(([ts, o, h, l, c, v]) => {
      const d   = moment.unix(ts);
      const key = mode === "W"
        ? `${d.isoWeek()}_${d.year()}`
        : `${d.year()}_${d.format("MM")}`;

      if (!map.has(key)) map.set(key, [ts, o, h, l, c, v]);
      else {
        const m = map.get(key);
        m[2] = Math.max(m[2], h);
        m[3] = Math.min(m[3], l);
        m[4] = c;
        m[5] += v;
      }
    });
    return Array.from(map.values()).sort((a, b) => a[0] - b[0]);
  }
  
  /* ---------- sockets & profile --------------------------------- */
  async getProfile() { 
    await this.initialize();
    return this.fyers.get_profile(); 
  }
  
  async connectOrderSocket(tok) {
    if (!tok) throw new Error("token required");
    const orderSocket = require("./orderSocket");
    return orderSocket.connect(tok);
  }
  
  async connectDataSocket(tok) {
    if (!tok) throw new Error("token required");
    const dataSocket = require("./dataSocket");
    return dataSocket.connect(tok);
  }

  /**
   * Close database connection
   */
  close() {
    this.candleDB.close();
  }
}

// Export a singleton instance instead of the class
module.exports = new TradingService();
