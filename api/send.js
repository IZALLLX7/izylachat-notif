const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

async function isBlocked(toUsername, fromUsername) {
  if (!fromUsername) return false;
  const chatId = [fromUsername, toUsername].sort().join('_');
  const chat = await db.collection('chats').doc(chatId).get();
  if (!chat.exists) return false;
  return chat.get(new admin.firestore.FieldPath('blockedBy', toUsername)) === true;
}

async function isArchivedByReceiver(toUsername, fromUsername) {
  if (!fromUsername) return false;
  const snap = await db
    .collection('users')
    .doc(toUsername)
    .collection('contacts')
    .doc(fromUsername)
    .get();
  return snap.exists && snap.get('archived') === true;
}

async function resolveTitle(toUsername, fromUsername, fallbackTitle) {
  if (!fromUsername) return fallbackTitle;
  const snap = await db
    .collection('users')
    .doc(toUsername)
    .collection('private')
    .doc('contacts')
    .get();
  if (!snap.exists) return fallbackTitle;
  const custom = snap.get(new admin.firestore.FieldPath('names', fromUsername));
  return typeof custom === 'string' && custom.trim() ? custom.trim() : fallbackTitle;
}

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
    const fromUsername = data && data.chatWithUsername ? String(data.chatWithUsername) : null;

    if (await isBlocked(toUsername, fromUsername)) {
      res.status(200).json({ ok: true, skipped: true, reason: 'Pengirim diblokir penerima' });
      return;
    }

    if (await isArchivedByReceiver(toUsername, fromUsername)) {
      res.status(200).json({ ok: true, skipped: true, reason: 'Chat diarsipkan penerima' });
      return;
    }

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

    const tag = stringData.chatWithUsername || toUsername;

    const finalTitle = await resolveTitle(toUsername, fromUsername, title);

    await admin.messaging().send({
      token: toToken,
      notification: { title: finalTitle, body },
      data: stringData,
      android: {
        priority: 'high',
        notification: { channelId: 'chat_messages', tag },
      },
    });
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};
