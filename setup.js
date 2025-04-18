const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function setup() {
  console.log('🔧 Fyers API Setup 🔧');
  console.log('This script will help you set up your environment variables for the Fyers API.');
  console.log('You will need your Fyers App ID, Secret Key, and Redirect URI.');
  console.log('You can find these in your Fyers Developer Console: https://myapi.fyers.in/dashboard');
  console.log('');

  // Get Fyers App ID
  const appId = await askQuestion('Enter your Fyers App ID: ');
  
  // Get Fyers Secret Key
  const secretKey = await askQuestion('Enter your Fyers Secret Key: ');
  
  // Get Fyers Redirect URI
  const redirectUri = await askQuestion('Enter your Fyers Redirect URI (default: http://localhost:4000): ', 'http://localhost:4000');
  
  // Create .env file
  const envContent = `FYERS_APP_ID=${appId}
FYERS_SECRET_KEY=${secretKey}
FYERS_REDIRECT_URI=${redirectUri}
PORT=4000
`;

  const envPath = path.resolve(__dirname, '.env');
  fs.writeFileSync(envPath, envContent);
  console.log(`✅ Environment variables saved to ${envPath}`);
  
  console.log('');
  console.log('🎉 Setup complete! You can now run the application with:');
  console.log('node src/server.js');
  console.log('');
  console.log('The first time you run the application, it will prompt you to authenticate with Fyers.');
  console.log('Follow the instructions to complete the authentication process.');
  
  rl.close();
}

function askQuestion(question, defaultAnswer = '') {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim() || defaultAnswer);
    });
  });
}

setup().catch(console.error); 