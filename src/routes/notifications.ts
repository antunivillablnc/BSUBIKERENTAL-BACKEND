import { Router } from 'express';
import { db } from '../lib/firebase.js';

const router = Router();

// List notifications for a user by email or userId
router.get('/', async (req, res) => {
  try {
    const email = String(req.query.email || '');
    const userId = String(req.query.userId || '');
    if (!email && !userId) return res.status(400).json({ success: false, error: 'Email or userId is required.' });

    const query = userId
      ? db.collection('notifications').where('userId', '==', userId)
      : db.collection('notifications').where('userEmail', '==', email);

    let snap: any;
    try {
      snap = await query.orderBy('createdAt', 'desc').limit(50).get();
    } catch {
      snap = await query.get();
    }
    const rows = snap.docs.map((d: any) => {
      const data: any = d.data();
      const created = data?.createdAt?.toDate?.() || data?.createdAt;
      const createdAt = created instanceof Date ? created.toISOString() : created || null;
      return { id: d.id, ...data, createdAt };
    });
    return res.json({ success: true, notifications: rows });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Failed to load notifications' });
  }
});

// Server-Sent Events for live notifications
router.get('/stream', async (req, res) => {
  try {
    const email = String(req.query.email || '');
    const userId = String(req.query.userId || '');
    if (!email && !userId) return res.status(400).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const query = userId
      ? db.collection('notifications').where('userId', '==', userId)
      : db.collection('notifications').where('userEmail', '==', email);

    const unsubscribe = query.onSnapshot((snap: any) => {
      try {
        const items = snap.docs.map((d: any) => {
          const data: any = d.data();
          const created = data?.createdAt?.toDate?.() || data?.createdAt;
          const createdAt = created instanceof Date ? created.toISOString() : created || null;
          return { id: d.id, ...data, createdAt };
        });
        res.write(`data: ${JSON.stringify({ success: true, notifications: items })}\n\n`);
      } catch (err: any) {
        res.write(`data: ${JSON.stringify({ success: false, error: err?.message || 'stream error' })}\n\n`);
      }
    });

    const keepAlive = setInterval(() => { res.write(': keep-alive\n\n'); }, 25000);
    req.on('close', () => { clearInterval(keepAlive); unsubscribe(); res.end(); });
  } catch {
    res.status(500).end();
  }
});

export default router;


