// src/auth.js
const path = require('path');
const fs = require('fs');
const { fyersModel } = require('fyers-api-v3');
const readline = require('readline');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../.env') });

class FyersAuthManager {
  constructor() {
    this.fyers = null;
    this.tokenRefreshInterval = null;
    this.tokenExpiryTime = null;
    this.authCodePromise = null;
    this.authCodeResolve = null;
  }

  async initialize() {
    if (this.fyers) {
      return this.fyers;
    }

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

      // Set the token and try to validate it
      this.fyers.setAccessToken(accessToken);
      try {
        const profile = await this.fyers.get_profile();
        if (profile && profile.s === 'ok') {
          console.log('✅ Successfully authenticated with existing token');
          this.tokenExpiryTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
          return accessToken;
        }
      } catch (err) {
        console.log('❌ Existing token invalid, performing fresh authentication');
          return await this.performInteractiveAuth();
        }
    } catch (err) {
      console.error('❌ Authentication error:', err);
      return await this.performInteractiveAuth();
    }
  }

  async getAccessToken() {
    try {
      const tokenPath = path.resolve(__dirname, '../logs/access_token.txt');
    if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf8').trim();
        if (token) {
      return token;
    }
      }
      return null;
    } catch (err) {
      console.error('Error reading access token:', err);
      return null;
    }
  }

  setAuthCode(code) {
    if (this.authCodeResolve) {
      this.authCodeResolve(code);
      this.authCodeResolve = null;
    }
  }

  async performInteractiveAuth() {
    try {
      // Generate auth URL
      const authUrl = this.fyers.generateAuthCode();
      console.log('🔑 Please authorize the app by visiting:', authUrl);

      // Wait for auth code
      const authCode = await new Promise((resolve) => {
      this.authCodeResolve = resolve;
      });

      // Exchange auth code for access token
      const response = await this.fyers.generate_access_token({
        client_id: process.env.FYERS_APP_ID,
        secret_key: process.env.FYERS_SECRET_KEY,
        auth_code: authCode,
      });

      if (response.s === 'ok' && response.access_token) {
        // Save token
        const tokenPath = path.resolve(__dirname, '../logs/access_token.txt');
        fs.writeFileSync(tokenPath, response.access_token);
        
        // Set token and expiry
        this.fyers.setAccessToken(response.access_token);
        this.tokenExpiryTime = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
        
        console.log('✅ Successfully authenticated with new token');
        return response.access_token;
      } else {
      throw new Error('Failed to get access token: ' + JSON.stringify(response));
      }
    } catch (err) {
      console.error('❌ Interactive authentication failed:', err);
      throw err;
    }
  }

  startTokenRefresh() {
    // Clear any existing interval
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
    }

    // Refresh token every 23 hours
    this.tokenRefreshInterval = setInterval(async () => {
        try {
          await this.authenticate();
      } catch (err) {
        console.error('❌ Token refresh failed:', err);
      }
    }, 23 * 60 * 60 * 1000);
  }

  stopTokenRefresh() {
    if (this.tokenRefreshInterval) {
      clearInterval(this.tokenRefreshInterval);
      this.tokenRefreshInterval = null;
    }
  }

  async validateToken() {
    try {
      const profile = await this.fyers.get_profile();
      return profile && profile.s === 'ok';
    } catch (err) {
      return false;
    }
  }
}

module.exports = new FyersAuthManager();
