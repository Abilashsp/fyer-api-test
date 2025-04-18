'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const { fyersModel } = require('fyers-api-v3');
const auth = require('./auth');
const api = require('./api');
const orderSocket = require('./orderSocket');
const dataSocket  = require('./dataSocket');

(async () => {
  // 1️⃣ ensure logs folder exists
  const logDir = path.resolve(__dirname, '../logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

  // 2️⃣ init the API client
  const fyers = new fyersModel({ path: logDir, enableLogging: true });
  fyers.setAppId(process.env.FYERS_APP_ID);
  fyers.setRedirectUrl(process.env.FYERS_REDIRECT_URI);

  // 3️⃣ authenticate
  const accessToken = await auth.authenticate(fyers);
  fyers.setAccessToken(accessToken);

  // 4️⃣ quick profile check
  const profile = await api.getProfile(fyers);
  console.log('Profile:', profile);

  // 5️⃣ hand off to your socket module
  //    🔑 Pass only APPID and the raw access token
  const socketToken = `${process.env.FYERS_APP_ID}:${accessToken}`;
  orderSocket.connect(socketToken, logDir, true);
  dataSocket.connect(socketToken,  logDir, true);
})();
