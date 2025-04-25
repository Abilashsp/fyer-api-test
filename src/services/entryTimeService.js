const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const moment = require('moment');

class EntryTimeService {
  constructor() {
    this.dbPath = path.join(__dirname, '../../data/entry_times.db');
    this.ensureDbDirectory();
    this.db = new sqlite3.Database(this.dbPath);
    this.initializeTables();
    this.lastCleanupDate = null;
    this.initializeCleanup();
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
        CREATE TABLE IF NOT EXISTS entry_times (
          symbol TEXT,
          resolution TEXT,
          entry_time INTEGER,
          last_candle_time INTEGER,
          last_update_time INTEGER,
          last_cleanup_date TEXT,
          PRIMARY KEY (symbol, resolution)
        )
      `);
    });
  }

  async initializeCleanup() {
    try {
      const today = moment().format('YYYY-MM-DD');
      const lastCleanup = await this.getLastCleanupDate();
      
      if (lastCleanup !== today) {
        await this.cleanupOldData();
        this.lastCleanupDate = today;
      }
    } catch (error) {
      console.error('Error initializing cleanup:', error);
    }
  }

  async getLastCleanupDate() {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT MAX(last_cleanup_date) as last_cleanup FROM entry_times',
        (err, row) => {
          if (err) reject(err);
          resolve(row?.last_cleanup || null);
        }
      );
    });
  }

  async cleanupOldData() {
    return new Promise((resolve, reject) => {
      const today = moment().format('YYYY-MM-DD');
      this.db.run(
        `UPDATE entry_times 
         SET last_cleanup_date = ?,
             entry_time = NULL,
             last_candle_time = NULL
         WHERE last_cleanup_date != ? OR last_cleanup_date IS NULL`,
        [today, today],
        (err) => {
          if (err) reject(err);
          resolve();
        }
      );
    });
  }

  async getEntryTime(symbol, resolution) {
    return new Promise((resolve, reject) => {
      this.db.get(
        'SELECT * FROM entry_times WHERE symbol = ? AND resolution = ?',
        [symbol, resolution],
        (err, row) => {
          if (err) reject(err);
          resolve(row);
        }
      );
    });
  }

  async updateEntryTime(symbol, resolution, entryTime, lastCandleTime) {
    return new Promise((resolve, reject) => {
      const today = moment().format('YYYY-MM-DD');
      this.db.run(
        `INSERT OR REPLACE INTO entry_times 
         (symbol, resolution, entry_time, last_candle_time, last_update_time, last_cleanup_date)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [symbol, resolution, entryTime, lastCandleTime, Date.now(), today],
        (err) => {
          if (err) reject(err);
          resolve();
        }
      );
    });
  }

  async isEntryTimeStale(symbol, resolution, maxAgeMs = 24 * 60 * 60 * 1000) {
    const data = await this.getEntryTime(symbol, resolution);
    if (!data) return true;
    
    // Check if data is from a different day
    const today = moment().format('YYYY-MM-DD');
    if (data.last_cleanup_date !== today) return true;
    
    return (Date.now() - data.last_update_time) > maxAgeMs;
  }

  calculateNextEntryTime(lastCandleTime, resolution) {
    const resMin = parseInt(resolution, 10);
    let entryTime;
    
    if (resolution === 'D') {
      // For daily candles, entry time is next day's open
      entryTime = moment.unix(lastCandleTime).add(1, 'day').startOf('day').add(9, 'hours').add(15, 'minutes');
    } else {
      // For intraday candles, entry time is next candle's start
      entryTime = moment.unix(lastCandleTime).add(resMin, 'minutes');
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

    return entryTime.unix();
  }

  calculateLastEntryTime(currentTime, resolution) {
    const resMin = parseInt(resolution, 10);
    let lastEntryTime;
    
    // Market hours
    const marketOpen = moment(currentTime).startOf('day').add(9, 'hours').add(15, 'minutes');
    const marketClose = moment(currentTime).startOf('day').add(15, 'hours').add(15, 'minutes');
    
    if (resolution === 'D') {
      // For daily candles, last entry time is today's open
      lastEntryTime = marketOpen;
    } else {
      // Calculate candle start times for the day
      const candleStartTimes = [];
      let currentCandle = marketOpen;
      
      while (currentCandle.isBefore(marketClose)) {
        candleStartTimes.push(currentCandle.clone());
        currentCandle.add(resMin, 'minutes');
      }
      
      // Find the last candle start time before current time
      lastEntryTime = marketOpen;
      for (const candleTime of candleStartTimes) {
        if (candleTime.isBefore(currentTime)) {
          lastEntryTime = candleTime;
        } else {
          break;
        }
      }
    }

    // If current time is before market open, return previous day's last candle
    if (moment(currentTime).isBefore(marketOpen)) {
      if (resolution === 'D') {
        lastEntryTime = moment(currentTime).subtract(1, 'day').startOf('day').add(9, 'hours').add(15, 'minutes');
      } else {
        const prevDay = moment(currentTime).subtract(1, 'day');
        const prevMarketOpen = prevDay.startOf('day').add(9, 'hours').add(15, 'minutes');
        const prevMarketClose = prevDay.startOf('day').add(15, 'hours').add(15, 'minutes');
        
        // Calculate last candle of previous day
        const totalMinutes = prevMarketClose.diff(prevMarketOpen, 'minutes');
        const candlesPerDay = Math.floor(totalMinutes / resMin);
        lastEntryTime = prevMarketOpen.add(candlesPerDay * resMin, 'minutes');
      }
    }
    
    // If current time is after market close, return today's last candle
    if (moment(currentTime).isAfter(marketClose)) {
      if (resolution === 'D') {
        lastEntryTime = marketOpen;
      } else {
        const totalMinutes = marketClose.diff(marketOpen, 'minutes');
        const candlesPerDay = Math.floor(totalMinutes / resMin);
        lastEntryTime = marketOpen.add(candlesPerDay * resMin, 'minutes');
      }
    }

    return lastEntryTime.unix();
  }

  async getAllEntryTimes(symbols, resolution) {
    try {
      // Check and perform cleanup if needed
      await this.initializeCleanup();
      
      const results = [];
      const currentTime = moment();
      
      for (const symbol of symbols) {
        const entryTimeData = await this.getEntryTime(symbol, resolution);
        const lastEntryTime = this.calculateLastEntryTime(currentTime, resolution);
        
        // Calculate all candle start times for the day
        const marketOpen = moment(currentTime).startOf('day').add(9, 'hours').add(15, 'minutes');
        const marketClose = moment(currentTime).startOf('day').add(15, 'hours').add(15, 'minutes');
        const candleStartTimes = [];
        
        if (resolution === 'D') {
          candleStartTimes.push(marketOpen.unix());
        } else {
          let currentCandle = marketOpen;
          while (currentCandle.isBefore(marketClose)) {
            candleStartTimes.push(currentCandle.unix());
            currentCandle.add(parseInt(resolution, 10), 'minutes');
          }
        }
        
        if (entryTimeData) {
          results.push({
            symbol,
            time: moment.unix(entryTimeData.entry_time).format('YYYY-MM-DD HH:mm:ss'),
            timestamp: entryTimeData.entry_time,
            resolution,
            lastCandleTime: moment.unix(entryTimeData.last_candle_time).format('YYYY-MM-DD HH:mm:ss'),
            lastEntryTime: moment.unix(lastEntryTime).format('YYYY-MM-DD HH:mm:ss'),
            lastEntryTimestamp: lastEntryTime,
            candleStartTimes: candleStartTimes.map(t => moment.unix(t).format('HH:mm:ss'))
          });
        } else {
          // If no entry time exists for this resolution, calculate it
          const lastCandleTime = Math.floor(Date.now() / 1000);
          const entryTime = this.calculateNextEntryTime(lastCandleTime, resolution);
          
          // Store the new entry time
          await this.updateEntryTime(symbol, resolution, entryTime, lastCandleTime);
          
          results.push({
            symbol,
            time: moment.unix(entryTime).format('YYYY-MM-DD HH:mm:ss'),
            timestamp: entryTime,
            resolution,
            lastCandleTime: moment.unix(lastCandleTime).format('YYYY-MM-DD HH:mm:ss'),
            lastEntryTime: moment.unix(lastEntryTime).format('YYYY-MM-DD HH:mm:ss'),
            lastEntryTimestamp: lastEntryTime,
            candleStartTimes: candleStartTimes.map(t => moment.unix(t).format('HH:mm:ss'))
          });
        }
      }
      return results.sort((a, b) => a.lastEntryTimestamp - b.lastEntryTimestamp);
    } catch (error) {
      console.error('Error getting all entry times:', error);
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

module.exports = new EntryTimeService(); 