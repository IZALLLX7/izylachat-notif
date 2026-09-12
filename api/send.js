/*
  DATABASE × VERCEL
*/
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

  const { toUsername, title, body, data } = req.body || {};

  if (!toUsername || !title || !body) {
    res.status(400).json({ error: 'toUsername, title, dan body wajib diisi' });
    return;
  }

  try {
    const privateDoc = await db
      .collection('users')
      .doc(toUsername)
      .collection('private')
      .doc('fcm')
      .get();

    const toToken = privateDoc.exists ? privateDoc.data().token : null;
    if (!toToken) {
      res.status(200).json({ ok: true, skipped: true, reason: 'User belum punya token FCM' });
      return;
    }

    const stringData = {};
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        stringData[key] = String(value);
      }
    }

    await admin.messaging().send({
      token: toToken,
      notification: { title, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: { channelId: 'chat_messages' },
      },
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
