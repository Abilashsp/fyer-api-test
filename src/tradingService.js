/* ------------------------------------------------------------------ */
/*  tradingService.js – Fyers API v3  |  SQLite cache + retry logic   */
/* ------------------------------------------------------------------ */
const { fyersModel } = require("fyers-api-v3");
const authManager    = require("./auth2.0");
const moment         = require("moment");
const path           = require("path");
const dotenv         = require("dotenv");
const candleDB       = require("./candleDB");          // ← SQLite wrapper

dotenv.config({ path: path.resolve(__dirname, "../.env") });

/* ----------------------------- helpers --------------------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function maxDaysFor(resMin) {
  if (resMin <= 15)  return 30;
  if (resMin <= 60)  return 180;
  if (resMin <= 120) return 180;
  return 365;
}

class RateLimiter {
  constructor(maxPerMin = 8) {
    this.max    = maxPerMin;
    this.tokens = maxPerMin;
    this.rate   = maxPerMin / 60;      // tokens per second
    this.last   = Date.now();
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

/* ------------------------------------------------------------------ */
class TradingService {
  constructor() {
    this.fyers     = null;
    this.limiter   = new RateLimiter(8);
    this.cache     = new Map();          // key → { ts, data }
    this.cacheTTL  = 5 * 60_000;         // 5 minutes
    this.lastCall  = 0;
  }

  /* ---------------- bootstrap (unchanged) ----------------------- */
  async initialize() {
    if (this.fyers) return this;

    await authManager.initialize();
    let token = await authManager.getAccessToken();
    if (!token) token = await authManager.authenticate();
    if (!token) throw new Error("Failed to get access token");

    console.log("🔑 using token:", token.slice(0, 30), "…");

    this.fyers = new fyersModel({ path: path.resolve(__dirname, "../logs"), enableLogging: true });
    this.fyers.setAppId(process.env.FYERS_APP_ID);
    this.fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);
    this.fyers.setAccessToken(token);

    const profile = await this.fyers.get_profile();
    if (!profile || profile.s !== "ok") throw new Error("Profile validation failed");
    console.log("✅ Fyers client initialised");
    return this;
  }

  /* ---------------- low-level fetch with retries ---------------- */
  async _fetch(params, sym, resStr, want, retry = 0) {
    const resMin  = /^\d+$/.test(resStr) ? Number(resStr) : null;
    const isIntra = !!resMin;
    const limitD  = isIntra ? maxDaysFor(resMin) : 365;

    if (retry > 3)
      return { success: false, candles: [] };

    try {
      /* convert YYYY-MM-DD to Unix ts if API needs it ------------ */
      const original = { ...params };
      if (params.date_format === "1") {
        for (const k of ["range_from", "range_to"]) {
          if (params[k] && isNaN(Number(params[k]))) {
            const m = moment(params[k], "YYYY-MM-DD");
            if (m.isValid()) params[k] = String(m.unix());
          }
        }
        params.date_format = "0";
      }

      const resp = await this.fyers.getHistory(params);
      if (!resp || resp.s !== "ok" || !Array.isArray(resp.candles))
        throw new Error(resp?.s || "API error");

      const candles = resp.candles;                 // Fyers returns ms
      if (candles.length >= want || !isIntra)
        return { success: true, candles };

      /* ------------ need more intraday data --------------------- */
      const earliest = moment().subtract(limitD, "days").unix();

      if (original.date_format === "1") {
        const f = moment(original.range_from, "YYYY-MM-DD");
        const t = moment(original.range_to,   "YYYY-MM-DD");
        const span = t.diff(f, "days");
        const newFrom = f.subtract(span * (retry + 1), "days");
        if (newFrom.unix() <= earliest) return { success: true, candles };

        original.range_from = newFrom.format("YYYY-MM-DD");
        await sleep(1000 * 2 ** retry);
        const more = await this._fetch(original, sym, resStr, want, retry + 1);
        return { success: true, candles: [...candles, ...more.candles].sort((a, b) => a[0] - b[0]) };
      }

      const span = Number(params.range_to) - Number(params.range_from);
      const nextFrom = Number(params.range_from) - span * (retry + 1);
      if (nextFrom <= earliest) return { success: true, candles };

      params.range_from = String(nextFrom);
      await sleep(1000 * 2 ** retry);
      const more = await this._fetch(params, sym, resStr, want, retry + 1);

      const seen = new Set(candles.map(c => c[0]));
      const merged = [...candles, ...more.candles.filter(c => !seen.has(c[0]))]
                     .sort((a, b) => a[0] - b[0]);
      return { success: true, candles: merged };
    } catch (err) {
      console.error(`❌ fetch ${sym}@${resStr}: ${err.message}`);
      await sleep(1000 * 2 ** retry);
      return this._fetch(params, sym, resStr, want, retry + 1);
    }
  }

  /* ---------------- public: getHistoricalData ------------------- */
  async getHistoricalData(symbol, resolution = "D", lookback = 365) {
    /* 1️⃣ normalise resolution ---------------------------------- */
    let res = String(resolution).toUpperCase().trim();
    if (res === "240") res = "120";
    if (/^\d+M$/i.test(res)) res = res.slice(0, -1);
    if (/^\d+H$/i.test(res)) res = String(parseInt(res) * 60);
    if (res === "1D") res = "D";
    if (res !== "D" && res !== "W" && res !== "M" && !/^\d+$/.test(res))
      throw new Error(`Bad resolution: ${resolution}`);

    /* 2️⃣ weekly / monthly roll-up ------------------------------ */
    if (res === "W" || res === "M") {
      const days = res === "W" ? lookback * 7 : lookback * 31;
      const daily = await this.getHistoricalData(symbol, "D", days);
      return { success: daily.success, candles: this._rollup(daily.candles, res) };
    }

    /* 3️⃣ obey rate-limit -------------------------------------- */
    await this.limiter.wait();
    const lag = Date.now() - this.lastCall;
    if (lag < 500) await sleep(500 - lag);
    this.lastCall = Date.now();

    /* 4️⃣ compute look-back window ------------------------------ */
    const WANT   = 200;
    const resMin = res === "D" ? 1440 : Number(res);
    const backDays = Math.min(
      Math.ceil((WANT * resMin) / (6.5 * 60)) * 1.3,
      maxDaysFor(resMin)
    );
    const end   = moment().unix();
    const start = moment().subtract(backDays, "days").unix();

    /* 5️⃣ SQLite first ----------------------------------------- */
    if (candleDB.countCandles(symbol, res, start, end) >= WANT) {
      const candles = candleDB.getCandles(symbol, res, start, end);
      const ok = { success: true, candles };
      this.cache.set(`${symbol}_${res}_${start}_${end}`, { ts: Date.now(), data: ok });
      return ok;
    }

    /* 6️⃣ RAM cache -------------------------------------------- */
    const key = `${symbol}_${res}_${start}_${end}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheTTL) return hit.data;

    /* 7️⃣ call API --------------------------------------------- */
    const p = {
      symbol,
      resolution : res,
      date_format: "1",
      range_from : moment.unix(start).format("YYYY-MM-DD"),
      range_to   : moment.unix(end).format("YYYY-MM-DD"),
      cont_flag  : "1"
    };
    console.log(`📈 ${symbol}@${res} ${p.range_from} → ${p.range_to}`);

    let result = await this._fetch(p, symbol, res, WANT);
    if (!result || typeof result !== "object")
      result = { success: false, candles: [] };
    if (!("success" in result))
      result = { success: true, candles: result.candles ?? [] };

    /* 8️⃣ persist & memoise ------------------------------------ */
    if (result.success && Array.isArray(result.candles) && result.candles.length) {
      candleDB.storeCandles(symbol, res, result.candles);
    }
    this.cache.set(key, { ts: Date.now(), data: result });
    return result;
  }

  /* ---------------- roll-up helper ------------------------------ */
  _rollup(daily, mode) {
    if (!daily?.length) return [];
    const m = new Map();
    daily.forEach(([ts, o, h, l, c, v]) => {
      const d = moment.unix(ts);
      const key = mode === "W" ? `${d.isoWeek()}_${d.year()}` : `${d.year()}_${d.format("MM")}`;
      if (!m.has(key)) m.set(key, [ts, o, h, l, c, v]);
      else {
        const r = m.get(key);
        r[2] = Math.max(r[2], h);
        r[3] = Math.min(r[3], l);
        r[4] = c;
        r[5] += v;
      }
    });
    return [...m.values()].sort((a, b) => a[0] - b[0]);
  }

  /* ---------------- misc pass-throughs -------------------------- */
  async getProfile()            { await this.initialize(); return this.fyers.get_profile(); }
  async connectOrderSocket(t)   { if (!t) throw new Error("token required"); return require("./orderSocket").connect(t); }
  async connectDataSocket(t)    { if (!t) throw new Error("token required"); return require("./dataSocket").connect(t); }
}

module.exports = new TradingService();
