const admin = require('firebase-admin');
const crypto = require('crypto');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const ALLOWED_FOLDERS = new Set(['chat_media', 'status_media', 'stickers']);
const DAILY_UPLOAD_LIMIT = 200;

async function checkAndBumpRateLimit(uid) {
  const today = new Date().toISOString().slice(0, 10);
  const ref = db.collection('uploadRateLimits').doc(`${uid}_${today}`);
  try {
    return await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const count = snap.exists ? (snap.data().count || 0) : 0;
      if (count >= DAILY_UPLOAD_LIMIT) return false;
      tx.set(
        ref,
        { count: count + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
        { merge: true },
      );
      return true;
    });
  } catch (err) {
    return true;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!idToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (err) {
    res.status(401).json({ error: 'Token tidak valid, coba login ulang' });
    return;
  }

  const { folder } = req.body || {};
  if (!ALLOWED_FOLDERS.has(folder)) {
    res.status(400).json({ error: 'folder tidak valid' });
    return;
  }

  const allowed = await checkAndBumpRateLimit(decoded.uid);
  if (!allowed) {
    res.status(429).json({ error: 'Terlalu banyak upload hari ini, coba lagi besok' });
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const paramsToSign = { folder, timestamp };
  const toSign = Object.keys(paramsToSign)
    .sort()
    .map((k) => `${k}=${paramsToSign[k]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(toSign + CLOUDINARY_API_SECRET)
    .digest('hex');

  res.status(200).json({
    signature,
    timestamp,
    apiKey: CLOUDINARY_API_KEY,
    cloudName: CLOUDINARY_CLOUD_NAME,
    folder,
  });
};
