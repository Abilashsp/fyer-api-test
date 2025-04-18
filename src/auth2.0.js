// src/auth.js
const path = require('path');
const fs = require('fs');
const { fyersModel } = require('fyers-api-v3');
const readline = require('readline');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

class FyersAuthManager {
  constructor() {
    this.fyers = null;
    this.tokenRefreshInterval = null;
    this.tokenExpiryTime = null;
  }

  async initialize() {
    const logDir = path.resolve(__dirname, '../logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }

    this.fyers = new fyersModel({
      path: logDir,
      enableLogging: true,
    });

    this.fyers.setAppId(process.env.FYERS_APP_ID);
    this.fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);

    await this.authenticate();
    this.startTokenRefresh();
    return this.fyers;
  }

  async authenticate() {
    try {
      const accessToken = await this.getAccessToken();
      if (!accessToken) {
        // If no token is available, perform interactive authentication
        return await this.performInteractiveAuth();
      }
      this.fyers.setAccessToken(accessToken);
      this.tokenExpiryTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
      return accessToken;
    } catch (error) {
      console.error('Authentication failed:', error);
      throw error;
    }
  }

  async getAccessToken() {
    // First try to get from environment
    const envToken = process.env.FYERS_ACCESS_TOKEN;
    if (envToken) {
      return envToken;
    }

    // If not in env, try to get from file
    const tokenPath = path.resolve(__dirname, '../.token');
    if (fs.existsSync(tokenPath)) {
      const token = fs.readFileSync(tokenPath, 'utf8');
      return token;
    }

    return null; // Return null instead of throwing error to allow interactive auth
  }

  async performInteractiveAuth() {
    console.log('No access token found. Starting interactive authentication...');
    
    // Generate URL and prompt user
    const url = this.fyers.generateAuthCode();
    console.log('Authorize the app by visiting:', url);

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const authCode = await new Promise(resolve => {
      rl.question('Enter the auth code: ', answer => {
        rl.close();
        resolve(answer.trim());
      });
    });

    // Exchange for token
    const response = await this.fyers.generate_access_token({
      client_id: process.env.FYERS_APP_ID,
      secret_key: process.env.FYERS_SECRET_KEY,
      auth_code: authCode,
    });

    if (response.s === 'ok') {
      const accessToken = response.access_token;
      
      // Save token to file for future use
      const tokenPath = path.resolve(__dirname, '../.token');
      fs.writeFileSync(tokenPath, accessToken);
      console.log('Access token saved to .token file');
      
      this.fyers.setAccessToken(accessToken);
      this.tokenExpiryTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
      return accessToken;
    }
    
    throw new Error('Failed to get access token: ' + JSON.stringify(response));
  }

  startTokenRefresh() {
    // Refresh token 1 hour before expiry
    this.tokenRefreshInterval = setInterval(async () => {
      if (Date.now() > (this.tokenExpiryTime - 60 * 60 * 1000)) {
        try {
          await this.authenticate();
          console.log('Token refreshed successfully');
        } catch (error) {
          console.error('Token refresh failed:', error);
        }
      }
    }, 5 * 60 * 1000); // Check every 5 minutes
  }

  stopTokenRefresh() {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }
  }

  async validateToken() {
    try {
      // In Fyers API v3, the method is get_profile instead of getProfile
      const profile = await this.fyers.get_profile();
      return true;
    } catch (error) {
      if (error.code === -16 || error.code === -300) {
        await this.authenticate();
        return true;
      }
      return false;
    }
  }
}

// Function to extract HSM key from access token
function extractHsmKeyFromToken(accessToken) {
  try {
    // The access token is a JWT token
    // The HSM key is included in the token payload
    // We need to decode the token to extract the HSM key
    const tokenParts = accessToken.split('.');
    if (tokenParts.length !== 3) {
      console.error('Invalid access token format');
      return null;
    }
    
    // Decode the payload (second part of the token)
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString());
    
    // Extract the HSM key from the payload
    if (payload.hsm_key) {
      return payload.hsm_key;
    } else {
      console.warn('HSM key not found in access token payload');
      return null;
    }
  } catch (error) {
    console.error('Error extracting HSM key from token:', error);
    return null;
  }
}

module.exports = new FyersAuthManager();
