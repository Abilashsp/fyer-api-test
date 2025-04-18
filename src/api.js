module.exports.getProfile = async function (fyers) {
    try {
      const profile = await fyers.get_profile();
      return profile;
    } catch (err) {
      console.error('API error:', err);
      throw err;
    }
  };
  