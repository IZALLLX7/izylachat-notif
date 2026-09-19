const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

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

  const { targetUsername, incomingCall } = req.body || {};
  if (!targetUsername || !incomingCall) {
    res.status(400).json({ error: 'targetUsername dan incomingCall wajib diisi' });
    return;
  }

  try {
    await db
      .collection('users')
      .doc(targetUsername)
      .set({ incomingCall }, { merge: true });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
