const readline = require('readline');

module.exports.authenticate = async function (fyers) {
  // Generate URL and prompt user
  const url = fyers.generateAuthCode();
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
    const response = await fyers.generate_access_token({
        client_id: process.env.FYERS_APP_ID,
        secret_key: process.env.FYERS_SECRET_KEY,
        auth_code: authCode,
      });
    
      if (response.s === 'ok') return response.access_token;
      throw new Error('Failed to get access token: ' + JSON.stringify(response));
    };
    