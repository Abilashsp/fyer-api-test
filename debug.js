// debug.js - Test script to debug specific symbols
const tradingService = require("./src/tradingService");
const Strategy = require("./src/strategy");
const dotenv = require("dotenv");
const path = require("path");

dotenv.config({ path: path.resolve(__dirname, "./.env") });

async function testSpecificSymbols() {
  try {
    // Initialize trading service
    await tradingService.initialize();
    
    // Create strategy instance with debug enabled
    const strategy = new Strategy(tradingService, null, { debug: true });
    
    console.log("======= Testing specific symbols =======");
    
    // Test NH symbol first
    console.log("\n----- Testing NSE:NH-EQ -----");
    const nhData = await tradingService.getHistoricalData("NSE:NH-EQ", "D", 300);
    if (nhData && nhData.candles.length > 0) {
      const lastPrice = nhData.candles[nhData.candles.length - 1][4]; // CLOSE price
      await strategy.tick("NSE:NH-EQ", lastPrice);
    } else {
      console.log("Could not fetch data for NSE:NH-EQ");
    }
    
    // Test AXISGOLD symbol
    console.log("\n----- Testing NSE:AXISGOLD-EQ -----");
    const axisData = await tradingService.getHistoricalData("NSE:AXISGOLD-EQ", "D", 300);
    if (axisData && axisData.candles.length > 0) {
      const lastPrice = axisData.candles[axisData.candles.length - 1][4]; // CLOSE price
      await strategy.tick("NSE:AXISGOLD-EQ", lastPrice);
    } else {
      console.log("Could not fetch data for NSE:AXISGOLD-EQ");
    }
    
    console.log("\n======= Testing completed =======");
    process.exit(0);
  } catch (error) {
    console.error("Error in testing:", error);
    process.exit(1);
  }
}

// Run the test
testSpecificSymbols();
