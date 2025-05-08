const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

async function setup() {
  try {
    console.log('🚀 Starting setup...');

    // Create necessary directories
    const dirs = [
      path.join(__dirname, 'data'),
      path.join(__dirname, 'logs'),
      path.join(__dirname, 'src/logs')
    ];

    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created directory: ${dir}`);
      }
    }

    // Check if .env exists
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) {
      console.error('❌ .env file not found. Please create one with your Fyers API credentials.');
      process.exit(1);
    }

    // Initialize database
    console.log('📁 Initializing database...');
    execSync('node src/scripts/initDb.js', { stdio: 'inherit' });

    console.log('✨ Setup completed successfully!');
  } catch (err) {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  }
}

setup(); 