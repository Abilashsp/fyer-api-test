const Database = require('better-sqlite3');
const moment = require('moment');
const path = require('path');
const fs = require('fs');

class CandleDB {
  constructor(dbPath = 'candles.db') {
    // Ensure the data directory exists
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL'); // Write-Ahead Logging for better concurrency
    this.db.pragma('synchronous = NORMAL'); // Good balance of safety and speed
    this.db.pragma('temp_store = MEMORY'); // Store temp tables and indices in memory
    this.db.pragma('mmap_size = 30000000000'); // 30GB memory map for better performance

    this._initTables();
  }

  _initTables() {
    // Create daily candles table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candles_daily (
        symbol       TEXT    NOT NULL,
        ts           INTEGER NOT NULL,
        open         REAL    NOT NULL,
        high         REAL    NOT NULL,
        low          REAL    NOT NULL,
        close        REAL    NOT NULL,
        volume       REAL    NOT NULL,
        PRIMARY KEY (symbol, ts)
      );

      CREATE INDEX IF NOT EXISTS idx_candles_daily_symbol_ts 
      ON candles_daily (symbol, ts DESC);

      CREATE TABLE IF NOT EXISTS sma_cache (
        symbol       TEXT    NOT NULL,
        resolution   TEXT    NOT NULL,
        period       INTEGER NOT NULL,
        ts           INTEGER NOT NULL,
        value        REAL    NOT NULL,
        PRIMARY KEY (symbol, resolution, period)
      );
    `);
  }

  /**
   * Store daily candles in the database
   * @param {string} symbol - Trading symbol
   * @param {Array} candles - Array of candle data [timestamp, open, high, low, close, volume]
   */
  storeDailyCandles(symbol, candles) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO candles_daily 
      (symbol, ts, open, high, low, close, volume)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const insert = this.db.transaction((candles) => {
      for (const candle of candles) {
        stmt.run(
          symbol,
          candle[0], // timestamp
          candle[1], // open
          candle[2], // high
          candle[3], // low
          candle[4], // close
          candle[5]  // volume
        );
      }
    });

    insert(candles);
  }

  /**
   * Get daily candles for a symbol within a time range
   * @param {string} symbol - Trading symbol
   * @param {number} startTs - Start timestamp (Unix seconds)
   * @param {number} endTs - End timestamp (Unix seconds)
   * @returns {Array} Array of candle data
   */
  getDailyCandles(symbol, startTs, endTs) {
    const stmt = this.db.prepare(`
      SELECT ts, open, high, low, close, volume
      FROM candles_daily
      WHERE symbol = ? AND ts >= ? AND ts <= ?
      ORDER BY ts ASC
    `);

    return stmt.all(symbol, startTs, endTs).map(row => [
      row.ts,
      row.open,
      row.high,
      row.low,
      row.close,
      row.volume
    ]);
  }

  /**
   * Get the latest candle timestamp for a symbol
   * @param {string} symbol - Trading symbol
   * @returns {number|null} Latest timestamp or null if no data
   */
  getLatestCandleTs(symbol) {
    const stmt = this.db.prepare(`
      SELECT MAX(ts) as latest
      FROM candles_daily
      WHERE symbol = ?
    `);

    const result = stmt.get(symbol);
    return result?.latest || null;
  }

  /**
   * Calculate and cache SMA values
   * @param {string} symbol - Trading symbol
   * @param {string} resolution - Time resolution
   * @param {number} period - SMA period
   * @param {Array} candles - Array of candle data
   */
  cacheSMA(symbol, resolution, period, candles) {
    if (candles.length < period) return;

    const sma = this._calculateSMA(candles, period);
    const latestTs = candles[candles.length - 1][0];

    // First, delete any existing SMA values for this symbol/resolution/period
    const deleteStmt = this.db.prepare(`
      DELETE FROM sma_cache 
      WHERE symbol = ? AND resolution = ? AND period = ?
    `);
    deleteStmt.run(symbol, resolution, period);

    // Then insert the new SMA value
    const insertStmt = this.db.prepare(`
      INSERT INTO sma_cache
      (symbol, resolution, period, ts, value)
      VALUES (?, ?, ?, ?, ?)
    `);

    insertStmt.run(symbol, resolution, period, latestTs, sma);
  }

  /**
   * Get cached SMA value
   * @param {string} symbol - Trading symbol
   * @param {string} resolution - Time resolution
   * @param {number} period - SMA period
   * @returns {number|null} Cached SMA value or null if not found
   */
  getCachedSMA(symbol, resolution, period) {
    const stmt = this.db.prepare(`
      SELECT value, ts
      FROM sma_cache
      WHERE symbol = ? AND resolution = ? AND period = ?
    `);

    return stmt.get(symbol, resolution, period);
  }

  /**
   * Calculate SMA from candle data
   * @private
   */
  _calculateSMA(candles, period) {
    const closes = candles.map(c => c[4]); // Close prices
    const sum = closes.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }

  /**
   * Check if we need to update the cache for a symbol
   * @param {string} symbol - Trading symbol
   * @param {number} maxAgeHours - Maximum age of data in hours
   * @returns {boolean} True if update is needed
   */
  needsUpdate(symbol, maxAgeHours = 24) {
    const latestTs = this.getLatestCandleTs(symbol);
    if (!latestTs) return true;

    const cutoff = moment().subtract(maxAgeHours, 'hours').unix();
    return latestTs < cutoff;
  }

  /**
   * Get symbols that need updates
   * @param {Array} symbols - Array of symbols to check
   * @param {number} maxAgeHours - Maximum age of data in hours
   * @returns {Array} Array of symbols needing updates
   */
  getSymbolsNeedingUpdate(symbols, maxAgeHours = 24) {
    return symbols.filter(symbol => this.needsUpdate(symbol, maxAgeHours));
  }

  /**
   * Close the database connection
   */
  close() {
    this.db.close();
  }
}

module.exports = CandleDB; 