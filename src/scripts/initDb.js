const fs = require('fs');
const path = require('path');
const cacheManager = require('../services/cacheManager');

async function initializeDatabase() {
  let dbInitialized = false;
  
  try {
    // Create data directory if it doesn't exist
    const dataDir = path.join(__dirname, '../../data');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
      console.log('✅ Created data directory:', dataDir);
    }

    // Check directory permissions
    try {
      fs.accessSync(dataDir, fs.constants.W_OK);
      console.log('✅ Data directory is writable');
    } catch (err) {
      throw new Error(`Data directory is not writable: ${dataDir}. Please check permissions.`);
    }

    // Initialize cache manager (this will create the database and tables)
    await cacheManager.initialize();
    dbInitialized = true;
    console.log('✅ Database initialized successfully');

    // Set up periodic cleanup of old data (runs daily)
    const cleanupInterval = setInterval(async () => {
      try {
        await cacheManager.cleanupOldData();
        console.log('✅ Old data cleanup completed');
      } catch (err) {
        console.error('❌ Error during cleanup:', err);
      }
    }, 24 * 60 * 60 * 1000); // Run every 24 hours

    // Handle process termination
    process.on('SIGINT', async () => {
      console.log('\n🛑 Shutting down...');
      clearInterval(cleanupInterval);
      if (dbInitialized) {
        await cacheManager.close();
      }
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      console.log('\n🛑 Shutting down...');
      clearInterval(cleanupInterval);
      if (dbInitialized) {
        await cacheManager.close();
      }
      process.exit(0);
    });

  } catch (err) {
    console.error('❌ Error initializing database:', err);
    if (dbInitialized) {
      await cacheManager.close();
    }
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  initializeDatabase().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
  });
}

module.exports = initializeDatabase; 