const moment = require("moment");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ────────────────────────────────────────────────────────────────
// 1. In-memory cache (symbol + resolution based)
// ----------------------------------------------------------------
const historyCache = new Map();
const CACHE_TTL_MIN = 10;
const cacheKey = (sym, res) => `${sym}|${res}`;
const saveToCache = (s, r, c) =>
  historyCache.set(cacheKey(s, r), { candles: c, tFetched: Date.now() });
const loadFromCache = (s, r) => {
  const item = historyCache.get(cacheKey(s, r));
  if (!item) return null;
  const ageMin = (Date.now() - item.tFetched) / 6e4;
  return ageMin > CACHE_TTL_MIN ? null : item.candles;
};

// ────────────────────────────────────────────────────────────────
// 2. TradingStrategy class
// ----------------------------------------------------------------
class TradingStrategy {
  constructor(tradingService, io, initialRes = "D") {
    this.svc = tradingService;
    this.io = io;
    this.defRes = initialRes;

    this.state = new Map(); // symbol => { candles, sum20, sum200, relPrev }
    this.bullish = [];
    this.bearish = [];
    this.pending = new Set();
    this.fetching = false;
  }

  _ensure(sym) {
    if (!this.state.has(sym)) {
      this.state.set(sym, { candles: [], sum20: 0, sum200: 0, relPrev: null });
    }
    return this.state.get(sym);
  }

  _relation(sum20, sum200) {
    return sum20 / 20 > sum200 / 200 ? "above" : "below";
  }

  _buildTrade(sym, candle, when) {
    const tgt = (candle.close + (candle.close - candle.low)).toFixed(2);
    return {
      key: sym,
      symbol: sym,
      exchange: "NSE",
      type: "EQU",
      price: candle.close.toString(),
      change: "0",
      changePercentage: "0%",
      entryPrice: candle.close,
      stopLoss: candle.low.toString(),
      target: tgt,
      liveReturns: "0",
      estimatedGains: "0",
      entryTime: when,
      entrydate: when,
      isProfit: true
    };
  }

  _emit(type, sym, when, candle, sma20, sma200) {
    const payload = {
      symbol: sym,
      date: when,
      type,
      sma20,
      sma200,
      resolution: this.defRes,   // <── add this
      trade: this._buildTrade(sym, candle, when)
    };
    

    console.log(type === "bullish" ? "🚀 BULLISH" : "⚡ BEARISH", payload);
    this.io?.emit(type === "bullish" ? "bullishSignal" : "bearishSignal", payload);
    (type === "bullish" ? this.bullish : this.bearish).push(payload);
  }

  _checkCross(sym, st) {
    if (st.candles.length < 200) return;

    const sma20 = st.sum20 / 20;
    const sma200 = st.sum200 / 200;
    const relNow = this._relation(st.sum20, st.sum200);

    if (st.relPrev && relNow !== st.relPrev) {
      const last = st.candles[st.candles.length - 1];
      const when = moment.unix(last.date).format("YYYY-MM-DD HH:mm:ss");
      this._emit(relNow === "above" ? "bullish" : "bearish", sym, when, last, sma20, sma200);
    }

    st.relPrev = relNow;
  }

  async _bootstrap(sym, res = this.defRes) {
    let candles = loadFromCache(sym, res);

    if (!candles) {
      const hist = await this.svc.getHistoricalData(sym, res);
      if (!hist.success) return console.warn(`⚠️ ${sym}@${res} fetch failed`);
      candles = hist.candles;
      saveToCache(sym, res, candles);
    }

    if (candles.length < 200) {
      return console.warn(`⚠️ ${sym}@${res} insufficient candles`);
    }

    const st = this._ensure(sym);
    st.candles = candles.map(c => ({ ...c, date: c.timestamp }));
    st.sum200 = st.candles.slice(-200).reduce((s, c) => s + c.close, 0);
    st.sum20 = st.candles.slice(-20).reduce((s, c) => s + c.close, 0);

    const prev20 = st.candles.slice(-21, -1).reduce((s, c) => s + c.close, 0);
    const prev200 = st.candles.slice(-201, -1).reduce((s, c) => s + c.close, 0);
    st.relPrev = prev200 === 0
      ? this._relation(st.sum20, st.sum200)
      : this._relation(prev20, prev200);

    this._checkCross(sym, st);
  }

  async analyzeMultiple(symbols, res = this.defRes) {
    for (const s of symbols) {
      try {
        await this._bootstrap(s, res);
      } catch (e) {
        console.error(e);
      }
      await sleep(300);
    }
  }

  async setResolution(newRes) {
    if (newRes === this.defRes) return;

    console.log(`🔁 Strategy timeframe ${this.defRes} → ${newRes}`);
    this.defRes = newRes;

    const symbols = [...this.state.keys()];
    this.state.clear();
    this.bullish.length = 0;
    this.bearish.length = 0;

    await this.analyzeMultiple(symbols, newRes);

    this.io.emit("clearSignals");
    this.io.emit("initialBullishSignals", this.getBullishSignals());
    this.io.emit("initialBearishSignals", this.getBearishSignals());
  }

  updateRealtimeDataFromSF({ symbol, ltp }) {
    const st = this.state.get(symbol);
    if (!st) {
      if (!this.pending.has(symbol)) {
        this.pending.add(symbol);
        this._processPending();
      }
      return;
    }

    const now = moment();
    const todayKey = now.startOf("day").valueOf();
    const last = st.candles[st.candles.length - 1];
    const lastKey = moment.unix(last.date).startOf("day").valueOf();

    if (todayKey === lastKey) {
      st.sum20 += ltp - (st.candles.length >= 20 ? st.candles[st.candles.length - 20].close : 0);
      st.sum200 += ltp - (st.candles.length >= 200 ? st.candles[st.candles.length - 200].close : 0);
      last.close = ltp;
      if (ltp > last.high) last.high = ltp;
      if (ltp < last.low) last.low = ltp;
    } else {
      const c = { date: now.unix(), open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 };
      st.candles.push(c);
      st.sum20 += ltp - (st.candles.length > 20 ? st.candles[st.candles.length - 21].close : 0);
      st.sum200 += ltp - (st.candles.length > 200 ? st.candles[st.candles.length - 201].close : 0);
      if (st.candles.length > 250) st.candles.shift();
    }

    this._checkCross(symbol, st);
  }

  async _processPending() {
    if (this.fetching) return;
    this.fetching = true;
    while (this.pending.size) {
      const sym = [...this.pending][0];
      this.pending.delete(sym);
      try {
        await this._bootstrap(sym, this.defRes);
      } catch (e) {
        console.error(e);
      }
      await sleep(300);
    }
    this.fetching = false;
  }

  clearHistoryCache(sym, res = this.defRes) {
    historyCache.delete(cacheKey(sym, res));
  }

  getBullishSignals() {
    return this.bullish;
  }

  getBearishSignals() {
    return this.bearish;
  }

  getResolution() {
    return this.defRes;
  }
}

module.exports = TradingStrategy;
