const { RtcTokenBuilder, RtcRole } = require('agora-token');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const secret = req.headers['x-app-secret'];
  if (secret !== process.env.APP_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { channelName, uid } = req.body || {};
  if (!channelName) {
    res.status(400).json({ error: 'channelName wajib diisi' });
    return;
  }

  try {
    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;

    const expirationTimeInSeconds = 7200;
    const currentTimestamp = Math.floor(Date.now() / 1000);
    const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid || 0,
      RtcRole.PUBLISHER,
      privilegeExpiredTs,
      privilegeExpiredTs
    );

    res.status(200).json({ token });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
