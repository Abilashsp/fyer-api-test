// tradingService.js
const { fyersModel } = require("fyers-api-v3");
const authManager    = require("./auth2.0");
const orderSocket    = require("./orderSocket");
const dataSocket     = require("./dataSocket");
const moment         = require("moment");

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------------ */
/* Token-bucket limiter (8 calls / minute)                            */
/* ------------------------------------------------------------------ */
class RateLimiter {
  constructor(maxPerMin) {
    this.max   = maxPerMin;
    this.tokens= maxPerMin;
    this.last  = Date.now();
    this.rate  = maxPerMin / 60; // tokens per sec
  }
  async wait() {
    this._refill();
    if (this.tokens < 1) {
      const wait = Math.ceil((1 / this.rate) * 1000);
      console.log(`⏳  rate-limit – waiting ${wait} ms`);
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
const limiter = new RateLimiter(8);

/* ------------------------------------------------------------------ */
/* Intraday look-back caps (calendar days)                            */
/* ------------------------------------------------------------------ */
function maxDaysFor(resMin) {
  if (resMin <= 15)  return 30;    // 1–15 min
  if (resMin <= 60)  return 180;   // 30 & 60 min
  if (resMin <= 120) return 180;   // 120 min
  return 365;                      // daily+
}

/* ------------------------------------------------------------------ */
class TradingService {
  constructor() {
    this.fyers     = null;
    this.cache     = new Map();          // key → {ts,data}
    this.cacheTTL  = 5 * 60_000;
    this.lastCall  = 0;
  }

  /* ---------- bootstrap ------------------------------------------ */
  async initialize() {
    this.fyers = await authManager.initialize();
    return this;
  }

  /* ---------- internal fetch with retries ------------------------ */
  async _fetch(params, sym, resStr, want, retry = 0) {
    const resMin  = /^\d+$/.test(resStr) ? Number(resStr) : null;
    const isIntra = !!resMin;
    const limitD  = isIntra ? maxDaysFor(resMin) : 365;

    if (retry > 3) {
      console.warn(`⚠️  max retries ${sym}@${resStr}`);
      return { success:false, candles:[] };
    }

    try {
      const resp = await this.fyers.getHistory(params);
      if (!resp || resp.s !== "ok" || !Array.isArray(resp.candles))
        throw new Error(resp?.s || "API error");

      const candles = resp.candles.map(([t,o,h,l,c,v]) =>
        ({ timestamp:t, open:o, high:h, low:l, close:c, volume:v })
      );

      if (candles.length >= want || !isIntra)
        return { success:true, candles };

      /* expand but stay inside maxDaysFor window ------------------ */
      const earliest = moment().subtract(limitD, "days").unix();
      const span     = Number(params.range_to) - Number(params.range_from);
      const nextFrom = Number(params.range_from) - span * (retry + 1);
      if (nextFrom <= earliest) return { success:true, candles };

      params.range_from = String(nextFrom);
      await sleep(1000 * 2 ** retry);
      return this._fetch(params, sym, resStr, want, retry + 1);
    } catch (err) {
      console.error(`❌  fetch ${sym}@${resStr}: ${err.message}`);
      await sleep(1000 * 2 ** retry);
      return this._fetch(params, sym, resStr, want, retry + 1);
    }
  }

  /* ---------- public: getHistoricalData -------------------------- */
  async getHistoricalData(symbol, resolution = "D", fromDate, toDate) {
    /* 1. normalise resolution ----------------------------------- */
    let res = String(resolution).toUpperCase().trim();

    if (res === "240") res = "120";                // ← 4-h fallback
    if (/^\d+M$/i.test(res)) res = res.slice(0, -1);           // 15M→15
    if (/^\d+H$/i.test(res)) res = String(parseInt(res) * 60); // 2H→120
    if (res === "1D") res = "D";
    if (res !== "D" && !/^\d+$/.test(res))
      throw new Error(`Bad resolution: ${resolution}`);

    /* 2. rate-limit -------------------------------------------- */
    await limiter.wait();
    const lag = Date.now() - this.lastCall;
    if (lag < 500) await sleep(500 - lag);
    this.lastCall = Date.now();

    /* 3. figure look-back window -------------------------------- */
    const WANT    = 200;
    const resMin  = res === "D" ? 1440 : Number(res);
    const dayMin  = 6.5 * 60;
    let backDays  = Math.ceil((WANT * resMin) / dayMin) * 1.3;
    backDays      = Math.min(backDays, maxDaysFor(resMin));

    const end   = toDate ? Math.min(moment(toDate).unix(), moment().unix()) : moment().unix();
    const start = fromDate ? moment(fromDate).unix()
                           : moment().subtract(backDays, "days").unix();

    /* 4. cache --------------------------------------------------- */
    const key = `${symbol}_${res}_${start}_${end}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheTTL) return hit.data;

    /* 5. build params & fetch ----------------------------------- */
    const p = {
      symbol,
      resolution : res,
      date_format: "0",
      range_from : String(start),
      range_to   : String(end),
      cont_flag  : "1",
    };

    console.log(`📈  ${symbol}@${res}  ${moment.unix(start).format("YYYY-MM-DD")} → ${moment.unix(end).format("YYYY-MM-DD")}`);
    const out = await this._fetch(p, symbol, res, WANT);
    this.cache.set(key, { ts:Date.now(), data:out });
    return out;
  }

  /* ---------- sockets & profile --------------------------------- */
  async getProfile()            { return this.fyers.get_profile(); }
  async connectOrderSocket(tok) { if (!tok) throw Error("token"); return orderSocket.connect(tok); }
  async connectDataSocket(tok)  { if (!tok) throw Error("token"); return dataSocket.connect(tok); }
}

module.exports = new TradingService();
