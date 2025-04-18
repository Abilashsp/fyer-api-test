const readlineV2 = require('readline');

module.exports.authenticate = async function(fyersV2) {
  const authUri = fyersV2.generateAuthCodeUri();
  console.log('Authorize V2 app by visiting:', authUri);
  const rl2 = readlineV2.createInterface({ input: process.stdin, output: process.stdout });
  const code2 = await new Promise(res => rl2.question('Enter V2 auth code: ', ans => { rl2.close(); res(ans.trim()); }));
  await fyersV2.setToken(code2);
  const tokenResp = await fyersV2.generateToken();
  if (tokenResp.access_token) return tokenResp.access_token;
  throw new Error('V2 token error: ' + JSON.stringify(tokenResp));
};
