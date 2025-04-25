const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

class SQLiteService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/history_cache.db');
    this.ensureDbDirectory();
    this.db = new sqlite3.Database(this.dbPath);
    this.initializeTables();
  }

  ensureDbDirectory() {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  initializeTables() {
    this.db.serialize(() => {
      this.db.run(`
        CREATE TABLE IF NOT EXISTS symbol_data (
          symbol TEXT,
          resolution TEXT,
          highest_high REAL,
          highest_low REAL,
          last_fetch_time INTEGER,
          last_candle_time INTEGER,
          PRIMARY KEY (symbol, resolution)
        )
      `);
    });
  }

  async getSymbolData(symbol, resolution) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM symbol_data WHERE symbol = ? AND resolution = ?',
        [symbol, resolution],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  async updateSymbolData(symbol, resolution, highestHigh, highestLow, lastCandleTime) {
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR REPLACE INTO symbol_data 
         (symbol, resolution, highest_high, highest_low, last_fetch_time, last_candle_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [symbol, resolution, highestHigh, highestLow, Date.now(), lastCandleTime],
        (err) => {
          if (err) reject(err);
          resolve();
        }
      );
    });
  }

  async isDataStale(symbol, resolution, maxAgeMs = 24 * 60 * 60 * 1000) {
    const data = await this.getSymbolData(symbol, resolution);
    if (!data) return true;
    return (Date.now() - data.last_fetch_time) > maxAgeMs;
  }

  async getLastCandleTime(symbol, resolution) {
    const data = await this.getSymbolData(symbol, resolution);
    return data ? data.last_candle_time : null;
  }

  close() {
    this.db.close();
  }
}

module.exports = new SQLiteService(); 