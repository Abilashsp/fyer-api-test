const tradingService = require('./tradingService');
const Strategy = require('./strategy');
const moment = require('moment');

async function main() {
  try {
    // Initialize trading service
    await tradingService.initialize();

    // Create strategy instance
    const strategy = new Strategy(tradingService, null, {
      debug: true,
      smaResolution: "D" // Use daily data for SMA calculations
    });

    // Example symbols to test
    const symbols = [
      "NSE:RELIANCE-EQ",
      "NSE:TCS-EQ",
      "NSE:INFY-EQ"
    ];

    console.log("======= Testing SQLite Cache Integration =======");

    // First run - should fetch from API and cache in SQLite
    console.log("\n----- First Run (API + Cache) -----");
    for (const symbol of symbols) {
      console.log(`\nProcessing ${symbol}:`);
      
      // Get historical data (will be cached in SQLite)
      const { candles } = await tradingService.getHistoricalData(symbol, "D", 300);
      console.log(`✅ Fetched ${candles.length} daily candles`);
      
      // Get SMA values (will be cached in SQLite)
      const sma20 = strategy.getSMA(symbol, 20);
      const sma50 = strategy.getSMA(symbol, 50);
      const sma200 = strategy.getSMA(symbol, 200);
      console.log(`✅ Cached SMAs: 20=${sma20?.toFixed(2)}, 50=${sma50?.toFixed(2)}, 200=${sma200?.toFixed(2)}`);
    }

    // Second run - should use SQLite cache
    console.log("\n----- Second Run (Cache Only) -----");
    for (const symbol of symbols) {
      console.log(`\nProcessing ${symbol}:`);
      
      // Get historical data (should come from SQLite)
      const { candles } = await tradingService.getHistoricalData(symbol, "D", 300);
      console.log(`✅ Retrieved ${candles.length} daily candles from cache`);
      
      // Get SMA values (should come from SQLite)
      const sma20 = strategy.getSMA(symbol, 20);
      const sma50 = strategy.getSMA(symbol, 50);
      const sma200 = strategy.getSMA(symbol, 200);
      console.log(`✅ Retrieved SMAs from cache: 20=${sma20?.toFixed(2)}, 50=${sma50?.toFixed(2)}, 200=${sma200?.toFixed(2)}`);
    }

    // Clean up
    tradingService.close();
    console.log("\n======= Test completed =======");
    process.exit(0);
  } catch (error) {
    console.error("Error in example:", error);
    process.exit(1);
  }
}

main(); 