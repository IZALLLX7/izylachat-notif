const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

const MAX_POST_AGE_MS = 10 * 60 * 1000;
const FOLLOWER_PAGE = 400;
const MAX_FOLLOWERS = 20000;

function previewOf(post) {
  const text = String(post.text || '').replace(/\s+/g, ' ').trim();
  let out;
  if (post.type === 'image') {
    out = text ? `📷 ${text}` : '📷 Foto';
  } else {
    out = text;
  }
  return out.length > 120 ? `${out.slice(0, 120)}…` : out;
}

async function sendInChunks(tokens, message) {
  const messaging = admin.messaging();
  const results = [];
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    const payload = { ...message, tokens: chunk };
    const resp = messaging.sendEachForMulticast
      ? await messaging.sendEachForMulticast(payload)
      : await messaging.sendMulticast(payload);
    resp.responses.forEach((r, idx) => {
      results.push({ token: chunk[idx], ok: r.success, code: r.error && r.error.code });
    });
  }
  return results;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const authHeader = String(req.headers.authorization || '');
  const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!idToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  let decoded;
  try {
    decoded = await admin.auth().verifyIdToken(idToken);
  } catch (_) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { channelId, postId } = req.body || {};
  const validId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 100 && !v.includes('/');
  if (!validId(channelId) || !validId(postId)) {
    res.status(400).json({ error: 'channelId dan postId wajib diisi' });
    return;
  }

  try {
    const chRef = db.collection('channels').doc(channelId);
    const postRef = chRef.collection('posts').doc(postId);
    const [chSnap, postSnap] = await Promise.all([chRef.get(), postRef.get()]);
    if (!chSnap.exists || !postSnap.exists) {
      res.status(404).json({ error: 'Saluran atau postingan gak ditemukan' });
      return;
    }
    const ch = chSnap.data();
    const post = postSnap.data();

    const adminUids = Array.isArray(ch.adminUids) ? ch.adminUids : [];
    if (!adminUids.includes(decoded.uid)) {
      res.status(403).json({ error: 'Bukan admin saluran' });
      return;
    }
    const senderUsername = String(post.sender || '');
    const senderDoc = senderUsername
      ? await db.collection('users').doc(senderUsername).get()
      : null;
    if (!senderDoc || !senderDoc.exists || senderDoc.get('uid') !== decoded.uid) {
      res.status(403).json({ error: 'Postingan ini bukan milikmu' });
      return;
    }

    const ts = post.timestamp && post.timestamp.toDate ? post.timestamp.toDate() : null;
    if (!ts || Date.now() - ts.getTime() > MAX_POST_AGE_MS) {
      res.status(200).json({ ok: true, skipped: true, reason: 'Postingan terlalu lama' });
      return;
    }

    const claimed = await db.runTransaction(async (tx) => {
      const p = await tx.get(postRef);
      if (p.get('notifiedAt')) return false;
      tx.update(postRef, { notifiedAt: admin.firestore.FieldValue.serverTimestamp() });
      return true;
    });
    if (!claimed) {
      res.status(200).json({ ok: true, skipped: true, reason: 'Sudah dinotifikasi' });
      return;
    }

    const message = {
      notification: {
        title: String(ch.name || 'Saluran'),
        body: previewOf(post) || 'Postingan baru',
      },
      data: { type: 'channel', channelId, postId },
      android: {
        priority: 'high',
        notification: { channelId: 'channel_posts', tag: `channel_${channelId}` },
      },
    };

    let processed = 0;
    let sent = 0;
    let failed = 0;
    let last = null;

    while (processed < MAX_FOLLOWERS) {
      let q = chRef
        .collection('followers')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(FOLLOWER_PAGE);
      if (last) q = q.startAfter(last);
      const page = await q.get();
      if (page.empty) break;
      last = page.docs[page.docs.length - 1];
      processed += page.size;

      const usernames = [];
      for (const d of page.docs) {
        const u = d.get('username');
        if (typeof u === 'string' && u && u !== senderUsername) usernames.push(u);
      }

      if (usernames.length > 0) {
        const fcmRefs = usernames.map((u) =>
          db.collection('users').doc(u).collection('private').doc('fcm'));
        const followedRefs = usernames.map((u) =>
          db.collection('users').doc(u).collection('followedChannels').doc(channelId));
        const snaps = await db.getAll(...fcmRefs, ...followedRefs);
        const fcmSnaps = snaps.slice(0, usernames.length);
        const followedSnaps = snaps.slice(usernames.length);

        const tokens = [];
        const owners = {};
        usernames.forEach((u, i) => {
          const f = followedSnaps[i];
          if (!f.exists || f.get('muted') === true) return;
          const token = fcmSnaps[i].exists ? fcmSnaps[i].get('token') : null;
          if (typeof token === 'string' && token) {
            tokens.push(token);
            owners[token] = u;
          }
        });

        if (tokens.length > 0) {
          const results = await sendInChunks(tokens, message);
          for (const r of results) {
            if (r.ok) {
              sent += 1;
            } else {
              failed += 1;
              if (
                r.code === 'messaging/registration-token-not-registered' ||
                r.code === 'messaging/invalid-registration-token'
              ) {
                const u = owners[r.token];
                if (u) {
                  db.collection('users').doc(u).collection('private').doc('fcm')
                    .update({ token: admin.firestore.FieldValue.delete() })
                    .catch(() => {});
                }
              }
            }
          }
        }
      }

      if (page.size < FOLLOWER_PAGE) break;
    }

    res.status(200).json({ ok: true, followers: processed, sent, failed });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
};