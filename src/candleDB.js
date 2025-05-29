// candleDB.js – single-file SQLite cache + rolling SMA columns
const Database = require("better-sqlite3");
const fs       = require("fs");
const path     = require("path");
const moment   = require("moment");

// Helper function to normalize resolution format to match Fyers API
function normalizeResolution(res) {
  // Convert the resolution to string and uppercase
  let r = String(res).toUpperCase().trim();
  
  // Handle minute format: "1M" -> "1", "5M" -> "5"
  if (/^\d+M$/i.test(r)) {
    return r.slice(0, -1); // Remove the 'M'
  }
  
  // Handle hour format: "1H" -> "60", "2H" -> "120"
  if (/^\d+H$/i.test(r)) {
    return String(parseInt(r) * 60); // Convert hours to minutes
  }
  
  // Handle day format: "1D" -> "D"
  if (r === "1D") {
    return "D";
  }
  
  return r;
}

class CandleDB {
  constructor() {
    const dbPath = path.resolve(__dirname, "../data/candles.sqlite");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 30000");          // wait up to 30 s for locks

    // Create main candles table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS candles (
        symbol          TEXT NOT NULL,
        resolution      TEXT NOT NULL,
        timestamp       TEXT NOT NULL,     -- Changed to TEXT for human-readable format
        unix_timestamp  INTEGER,          -- Added for original Unix timestamp
        open            REAL,
        high            REAL,
        low             REAL,
        close           REAL,
        volume          REAL,
        sma20           REAL,
        sma50           REAL,
        sma200          REAL,
        PRIMARY KEY (symbol, resolution, timestamp)
      );
      CREATE INDEX IF NOT EXISTS idx_candles_symbol_res_time
        ON candles(symbol, resolution, timestamp);
      CREATE INDEX IF NOT EXISTS idx_candles_symbol_res_unix
        ON candles(symbol, resolution, unix_timestamp);
    `);
    
    // Check if the unix_timestamp column exists, add it if it doesn't
    // This handles migration for existing databases
    const columns = this.db.prepare("PRAGMA table_info(candles)").all();
    if (!columns.some(col => col.name === 'unix_timestamp')) {
      console.log("Adding unix_timestamp column to candles table...");
      this.db.exec("ALTER TABLE candles ADD COLUMN unix_timestamp INTEGER;");
    }
    
    // Create views for each specific resolution
    this.createResolutionViews();

    this._insert = this.db.prepare(`
      INSERT OR REPLACE INTO candles
        (symbol, resolution, timestamp, unix_timestamp, open, high, low, close, volume,
         sma20, sma50, sma200)
      VALUES (@symbol, @resolution, @timestamp, @unix_timestamp, @open, @high, @low,
              @close, @volume, @sma20, @sma50, @sma200)
    `);
    
    // Prepare statements for querying SMA values
    this._getSMAsByResolution = {};
    
    // Create prepared statements for key resolutions
    const resolutions = ['1', '5', '60', '120', 'D'];
    for (const res of resolutions) {
      // Handle the special case for 'D' (daily) resolution
      const viewName = res === 'D' ? 'view_sma_D' : `view_sma_${res}`;
      
      try {
        this._getSMAsByResolution[res] = this.db.prepare(`
          SELECT symbol, 
                 sma20, sma50, sma200, timestamp 
          FROM ${viewName}
          WHERE symbol = ? 
          ORDER BY unix_timestamp DESC 
          LIMIT 1
        `);
      } catch (err) {
        console.error(`Error preparing statement for ${viewName}: ${err.message}`);
        // Create a fallback prepared statement using the main candles table
        this._getSMAsByResolution[res] = this.db.prepare(`
          SELECT symbol, 
                 sma20, sma50, sma200, timestamp 
          FROM candles
          WHERE symbol = ? AND resolution = ?
          ORDER BY unix_timestamp DESC 
          LIMIT 1
        `);
      }
    }
  }
  
  // Create SQLite views for each resolution to make SMA queries efficient
  createResolutionViews() {
    try {
      // Check if the candles table exists and has data
      const tableExists = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='candles'"
      ).get();
      
      if (!tableExists) {
        console.warn("Candles table doesn't exist yet, skipping view creation");
        return;
      }
      
      // Define the key resolutions we want to create views for
      const resolutions = [
        { name: 'view_sma_1', resolution: '1' },      // 1-minute
        { name: 'view_sma_5', resolution: '5' },      // 5-minute
        { name: 'view_sma_60', resolution: '60' },    // 60-minute (1-hour)
        { name: 'view_sma_120', resolution: '120' },  // 120-minute (2-hour)
        { name: 'view_sma_D', resolution: 'D' }       // Daily
      ];
      
      // Create or replace each view
      for (const { name, resolution } of resolutions) {
        try {
          // Drop existing view if it exists
          this.db.exec(`DROP VIEW IF EXISTS ${name}`);
          
          // Create view for this resolution
          this.db.exec(`
            CREATE VIEW ${name} AS
            SELECT 
              symbol, 
              unix_timestamp,
              timestamp,
              open, high, low, close, volume,
              sma20, sma50, sma200
            FROM candles
            WHERE resolution = '${resolution}'
          `);
          
          console.log(`Created view: ${name} for resolution '${resolution}'`);
        } catch (viewErr) {
          console.error(`Error creating view ${name}: ${viewErr.message}`);
        }
      }
      
      // Create a unified view with latest SMA values for all symbols and resolutions
      try {
        this.db.exec(`DROP VIEW IF EXISTS view_latest_sma;`);
        
        this.db.exec(`
          CREATE VIEW view_latest_sma AS
          WITH latest_timestamps AS (
            SELECT 
              symbol, 
              resolution, 
              MAX(unix_timestamp) AS latest_timestamp
            FROM candles
            GROUP BY symbol, resolution
          )
          SELECT 
            c.symbol, 
            c.resolution,
            c.timestamp,
            c.unix_timestamp,
            c.sma20, c.sma50, c.sma200
          FROM candles c
          JOIN latest_timestamps lt 
            ON c.symbol = lt.symbol 
            AND c.resolution = lt.resolution 
            AND c.unix_timestamp = lt.latest_timestamp
          WHERE c.sma20 IS NOT NULL AND c.sma50 IS NOT NULL AND c.sma200 IS NOT NULL
        `);
        
        console.log('Created view: view_latest_sma');
      } catch (unifiedViewErr) {
        console.error(`Error creating unified view: ${unifiedViewErr.message}`);
      }
    } catch (err) {
      console.error(`Error creating resolution views: ${err.message}`);
    }
  }

  // Get all SMA values for all key timeframes in a single call (most efficient)
  getAllTimeframeSMAs(symbol) {
    // Create a result object to store SMAs for each resolution
    const result = {
      '1': { sma20: null, sma50: null, sma200: null },
      '5': { sma20: null, sma50: null, sma200: null },
      '60': { sma20: null, sma50: null, sma200: null },
      '120': { sma20: null, sma50: null, sma200: null },
      'D': { sma20: null, sma50: null, sma200: null }
    };
    
    // First, check if we have data in the SQLite views
    console.log(`Checking SQLite views for ${symbol} SMAs across all timeframes`);
    
    try {
      // Get all SMAs from the latest_sma view (most efficient - single query for all timeframes)
      const allSMAs = this.db.prepare(`
        SELECT symbol, resolution, sma20, sma50, sma200 
        FROM view_latest_sma 
        WHERE symbol = ?
      `).all(symbol);
      
      // Track how many timeframes we got data for
      let timeframesFound = 0;
      
      // Populate the result object with values from the view
      for (const row of allSMAs) {
        const res = row.resolution;
        if (result[res]) {
          result[res] = {
            sma20: row.sma20,
            sma50: row.sma50,
            sma200: row.sma200
          };
          timeframesFound++;
          console.log(`✓ Found cached ${res} SMA values for ${symbol} in unified view`);
        }
      }
      
      console.log(`Found ${timeframesFound} of 5 timeframes in unified view`);
      
      // Check individual views for any missing values
      for (const res of Object.keys(result)) {
        if (!result[res].sma20 || !result[res].sma50 || !result[res].sma200) {
          try {
            // Try to get values from resolution-specific view first
            const viewName = res === 'D' ? 'view_sma_D' : `view_sma_${res}`;
            const smaValues = this.db.prepare(`
              SELECT sma20, sma50, sma200 
              FROM ${viewName} 
              WHERE symbol = ? 
              ORDER BY unix_timestamp DESC 
              LIMIT 1
            `).get(symbol);
            
            if (smaValues && smaValues.sma20 !== null && smaValues.sma50 !== null && smaValues.sma200 !== null) {
              result[res] = smaValues;
              console.log(`✓ Found cached ${res} SMA values for ${symbol} in dedicated view`);
            } else {
              // Fallback to individual SMA queries if view doesn't have data
              const sma20 = this.getCachedSMA(symbol, res, 20);
              const sma50 = this.getCachedSMA(symbol, res, 50);
              const sma200 = this.getCachedSMA(symbol, res, 200);
              
              if (sma20?.value && sma50?.value && sma200?.value) {
                result[res] = {
                  sma20: sma20.value,
                  sma50: sma50.value,
                  sma200: sma200.value
                };
                console.log(`✓ Found cached ${res} SMA values for ${symbol} using individual queries`);
              } else {
                console.log(`✗ No SMA cache for ${symbol} @ ${res}`);
              }
            }
          } catch (viewErr) {
            console.warn(`Error getting ${res} SMAs from view: ${viewErr.message}`);
          }
        }
      }
    } catch (err) {
      console.error(`Error getting all timeframe SMAs: ${err.message}`);
    }
    
    return result;
  }

  /* ---------- public API ---------------------------------------- */

  storeCandles(symbol, resolution, candlesArr) {
    // Normalize the resolution format to match Fyers API standards
    const normalizedResolution = normalizeResolution(resolution);
    
    console.log(`Storing ${candlesArr.length} candles for ${symbol} @ ${resolution} (normalized to ${normalizedResolution})`);
    
    if (!candlesArr || candlesArr.length === 0) {
      console.warn(`No candles to store for ${symbol} @ ${normalizedResolution}`);
      return;
    }
    
    // Log sample candle for debugging
    const sampleCandle = candlesArr[0];
    console.log(`Sample candle: timestamp=${sampleCandle[0]}, unix time=${moment.unix(sampleCandle[0]).format('YYYY-MM-DD HH:mm:ss')}`);
    
    const rows = candlesArr.map(c => {
      // Format timestamp based on resolution
      let formattedTimestamp;
      
      // Check if resolution is intraday (numeric) or daily/weekly/monthly
      if (['D', 'W', 'M'].includes(normalizedResolution)) {
        // For daily+ candles, use only date
        formattedTimestamp = moment.unix(c[0]).format('YYYY-MM-DD');
      } else {
        // For intraday candles (minutes), use date+time to avoid duplicates
        const m = moment.unix(c[0]);
        // Create a unique identifier by combining date with hour and minute
        // Minute-level resolution requires full precision
        if (parseInt(normalizedResolution) < 60) {
          formattedTimestamp = `${m.format('YYYY-MM-DD')}_${m.format('HH:mm')}`;
        } 
        // Hour-level resolution requires hour precision
        else if (parseInt(normalizedResolution) < 1440) {
          formattedTimestamp = `${m.format('YYYY-MM-DD')}_${m.format('HH')}h`;
        }
        // Fallback for any other intraday resolution
        else {
          formattedTimestamp = `${m.format('YYYY-MM-DD')}_${normalizedResolution}`;
        }
      }
      
      return {
        symbol,
        resolution: normalizedResolution, // Store normalized resolution
        timestamp: formattedTimestamp,   // Store appropriate timestamp format for resolution
        unix_timestamp: c[0],            // Also store original Unix timestamp
        open     : c[1],
        high     : c[2],
        low      : c[3],
        close    : c[4],
        volume   : c[5] ?? null,
        sma20    : null,
        sma50    : null,
        sma200   : null,
      };
    });
    
    try {
      const trx = this.db.transaction(arr => arr.forEach(r => this._insert.run(r)));
      trx(rows);
      console.log(`Successfully stored ${rows.length} candles for ${symbol} @ ${normalizedResolution}`);
      this._recalcSMA(symbol, normalizedResolution);
    } catch (err) {
      console.error(`Error storing candles for ${symbol} @ ${normalizedResolution}: ${err.message}`);
    }
  }

  getCandles(symbol, resolution, fromTS, toTS) {
    // Normalize the resolution format to match Fyers API standards
    const normalizedResolution = normalizeResolution(resolution);
    
    // Format timestamps based on Unix timestamps and resolution
    const fromMoment = typeof fromTS === 'number' ? moment.unix(fromTS) : moment(fromTS);
    const toMoment = typeof toTS === 'number' ? moment.unix(toTS) : moment(toTS);
    
    // Use unix_timestamp for the query instead of formatted timestamp
    // This is more accurate and avoids issues with different timestamp formats
    
    // Convert moment objects to Unix timestamps for consistent comparison
    const fromUnix = fromMoment.unix();
    const toUnix = toMoment.unix();
    
    console.log(`Fetching candles for ${symbol} @ ${resolution} (normalized to ${normalizedResolution}) from ${fromMoment.format('YYYY-MM-DD HH:mm')} to ${toMoment.format('YYYY-MM-DD HH:mm')}`);
    
    const results = this.db.prepare(`
      SELECT unix_timestamp, open, high, low, close, volume
      FROM candles
      WHERE symbol = ? AND resolution = ?
        AND unix_timestamp BETWEEN ? AND ?
      ORDER BY unix_timestamp ASC
    `).all(symbol, normalizedResolution, fromUnix, toUnix)
      .map(r => [r.unix_timestamp, r.open, r.high, r.low, r.close, r.volume]);
    
    console.log(`Found ${results.length} candles in database for ${symbol} @ ${normalizedResolution}`);
    return results;
  }

  countCandles(symbol, resolution, fromTS, toTS) {
    // Normalize the resolution format to match Fyers API standards
    const normalizedResolution = normalizeResolution(resolution);
    
    // Format timestamps based on Unix timestamps for consistency
    const fromMoment = typeof fromTS === 'number' ? moment.unix(fromTS) : moment(fromTS);
    const toMoment = typeof toTS === 'number' ? moment.unix(toTS) : moment(toTS);
    
    // Convert moment objects to Unix timestamps for consistent comparison
    const fromUnix = fromMoment.unix();
    const toUnix = toMoment.unix();
    
    return this.db.prepare(`
      SELECT COUNT(*) AS n
      FROM candles
      WHERE symbol = ? AND resolution = ?
        AND unix_timestamp BETWEEN ? AND ?
    `).get(symbol, normalizedResolution, fromUnix, toUnix).n;
  }

  getCachedSMA(symbol, resolution, period) {
    // Normalize the resolution format to match Fyers API standards
    const normalizedResolution = normalizeResolution(resolution);
    
    if (![20, 50, 200].includes(period)) {
      console.warn(`Unsupported SMA period: ${period}. Using default value.`);
      return { value: null };
    }

    const column = `sma${period}`;
    const result = this.db.prepare(`
      SELECT ${column} as value
      FROM candles
      WHERE symbol = ? AND resolution = ? AND ${column} IS NOT NULL
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(symbol, normalizedResolution);

    console.log(`Fetched cached SMA${period} for ${symbol} @ ${normalizedResolution}: ${result?.value || 'not found'}`);
    return result || { value: null };
  }
  
  // Get all SMA values (20, 50, 200) for a specific resolution from the view
  getAllSMA(symbol, resolution) {
    // Normalize the resolution format to match Fyers API standards
    const normalizedResolution = normalizeResolution(resolution);
    
    // Use the prepared statement for this resolution if available
    if (this._getSMAsByResolution[normalizedResolution]) {
      try {
        let result;
        
        // Check if we're using the fallback prepared statement (which requires resolution parameter)
        const stmt = this._getSMAsByResolution[normalizedResolution];
        const sql = stmt.source;
        
        if (sql.includes('resolution = ?')) {
          // This is the fallback prepared statement that needs resolution parameter
          result = stmt.get(symbol, normalizedResolution);
        } else {
          // This is the view-based prepared statement
          result = stmt.get(symbol);
        }
        
        if (result) {
          return {
            sma20: result.sma20,
            sma50: result.sma50,
            sma200: result.sma200,
            timestamp: result.timestamp
          };
        }
      } catch (err) {
        console.error(`Error fetching SMA values from view for ${symbol} @ ${normalizedResolution}: ${err.message}`);
      }
    }
    
    // Fallback: Query the main table if view doesn't exist or query failed
    const result = this.db.prepare(`
      SELECT sma20, sma50, sma200, timestamp
      FROM candles
      WHERE symbol = ? AND resolution = ? 
        AND sma20 IS NOT NULL 
        AND sma50 IS NOT NULL 
        AND sma200 IS NOT NULL
      ORDER BY unix_timestamp DESC
      LIMIT 1
    `).get(symbol, normalizedResolution);
    
    if (result) {
      return {
        sma20: result.sma20,
        sma50: result.sma50,
        sma200: result.sma200,
        timestamp: result.timestamp
      };
    }
    
    return { sma20: null, sma50: null, sma200: null, timestamp: null };
  }
  
  // Get all SMA values for multiple resolutions in a single call
  getAllTimeframeSMAs(symbol) {
    const resolutions = ['1', '5', '60', '120', 'D'];
    const result = {};
    
    for (const res of resolutions) {
      result[res] = this.getAllSMA(symbol, res);
    }
    
    return result;
  }

  cacheSMA(symbol, resolution, period, candles) {
    // Normalize the resolution format to match Fyers API standards
    const normalizedResolution = normalizeResolution(resolution);
    
    if (![20, 50, 200].includes(period)) {
      console.warn(`Unsupported SMA period: ${period}. Skipping.`);
      return false;
    }

    if (!candles || candles.length < period) {
      console.warn(`Not enough candles to calculate SMA${period}: got ${candles?.length || 0}, need ${period}`);
      return false;
    }

    console.log(`Calculating SMA${period} for ${symbol} @ ${resolution} (normalized to ${normalizedResolution})`);
    
    // Calculate SMA values for each candle
    const smaValues = this._calculateSMA(candles, period);
    const column = `sma${period}`;
    
    // Prepare database update statements
    const updateSMA = this.db.prepare(`
      UPDATE candles
      SET ${column} = ?
      WHERE symbol = ? AND resolution = ? AND timestamp = ?
    `);
    
    // Store candles first
    this.storeCandles(symbol, normalizedResolution, candles);
    
    // Update SMA values for each candle
    const trx = this.db.transaction(() => {
      for (let i = period - 1; i < candles.length; i++) {
        const unixTimestamp = candles[i][0];
        const m = moment.unix(unixTimestamp);
        let formattedTimestamp;
        
        // Format timestamp based on resolution, same logic as in storeCandles
        if (['D', 'W', 'M'].includes(normalizedResolution)) {
          formattedTimestamp = m.format('YYYY-MM-DD');
        } else {
          if (parseInt(normalizedResolution) < 60) {
            formattedTimestamp = `${m.format('YYYY-MM-DD')}_${m.format('HH:mm')}`;
          } else if (parseInt(normalizedResolution) < 1440) {
            formattedTimestamp = `${m.format('YYYY-MM-DD')}_${m.format('HH')}h`;
          } else {
            formattedTimestamp = `${m.format('YYYY-MM-DD')}_${normalizedResolution}`;
          }
        }
        
        const smaValue = smaValues[i - (period - 1)];
        updateSMA.run(smaValue, symbol, normalizedResolution, formattedTimestamp);
      }
    });
    
    try {
      trx();
      console.log(`Updated ${column} for ${symbol} @ ${normalizedResolution}, ${candles.length} candles`);
      return true;
    } catch (err) {
      console.error(`Error updating SMA${period} for ${symbol} @ ${normalizedResolution}: ${err.message}`);
      return false;
    }
  }
  
  _calculateSMA(candles, period) {
    const closes = candles.map(candle => candle[4]); // Close price is at index 4
    const smaValues = [];
    
    for (let i = 0; i <= closes.length - period; i++) {
      const slice = closes.slice(i, i + period);
      const average = slice.reduce((sum, price) => sum + price, 0) / period;
      smaValues.push(average);
    }
    
    return smaValues;
  }

  /* ---------- internal helpers --------------------------------- */

  _recalcSMA(symbol, resolution) {
    // Resolution is already normalized when called from other methods
    // No need to normalize it again, just double-check that it's properly formatted
    const normalizedResolution = normalizeResolution(resolution);
    if (normalizedResolution !== resolution) {
      console.warn(`Resolution mismatch in _recalcSMA: got ${resolution}, normalized to ${normalizedResolution}`);
    }
    
    console.log(`Recalculating SMAs for ${symbol} @ ${normalizedResolution}`);
    
    const rows = this.db.prepare(`
      SELECT timestamp, close
      FROM candles
      WHERE symbol = ? AND resolution = ?
      ORDER BY timestamp ASC
    `).all(symbol, normalizedResolution);

    if (!rows.length) {
      console.log(`No candles found for ${symbol} @ ${normalizedResolution}`);
      return;
    }

    const buf20 = [], buf50 = [], buf200 = [];
    const upd   = this.db.prepare(`
      UPDATE candles
      SET sma20  = ?, sma50 = ?, sma200 = ?
      WHERE symbol = ? AND resolution = ? AND timestamp = ?
    `);
    const avg = arr => arr.reduce((s, x) => s + x, 0) / arr.length;

    try {
      const trx = this.db.transaction(() => {
        rows.forEach(({ timestamp, close }) => {
          buf20.push(close);   if (buf20.length  >  20) buf20.shift();
          buf50.push(close);   if (buf50.length  >  50) buf50.shift();
          buf200.push(close);  if (buf200.length > 200) buf200.shift();
  
          // The timestamp is already in the correctly formatted string
          upd.run(
            buf20.length  ===  20 ? avg(buf20)  : null,
            buf50.length  ===  50 ? avg(buf50)  : null,
            buf200.length === 200 ? avg(buf200) : null,
            symbol, normalizedResolution, timestamp
          );
        });
      });
      trx();
      console.log(`Successfully recalculated SMAs for ${symbol} @ ${normalizedResolution}, ${rows.length} candles`);
    } catch (err) {
      console.error(`Error recalculating SMAs for ${symbol} @ ${normalizedResolution}: ${err.message}`);
    }
  }
}

module.exports = new CandleDB();
