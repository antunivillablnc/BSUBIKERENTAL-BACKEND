import { Router } from 'express';
import { db } from '../lib/firebase';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const email = String(req.query.email || '');
    const userId = String(req.query.userId || '');
    if (!email && !userId) return res.status(400).json({ success: false, error: 'Email or userId is required.' });

    const query = userId
      ? db.collection('applications').where('userId', '==', userId)
      : db.collection('applications').where('email', '==', email);
    const appsSnap = await query.orderBy('createdAt', 'desc').get();
    const applications = await Promise.all(
      appsSnap.docs.map(async d => {
        const app: any = { id: d.id, ...d.data() };
        // Normalize createdAt to ISO string for frontend simplicity
        const created = (app as any).createdAt?.toDate?.() || (app as any).createdAt;
        if (created instanceof Date) {
          (app as any).createdAt = created.toISOString();
        }
        if (app.bikeId) {
          const bikeDoc = await db.collection('bikes').doc(app.bikeId).get();
          app.bike = bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null;
        } else {
          app.bike = null;
        }
        return app;
      })
    );
    res.json({ success: true, applications });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load dashboard' });
  }
});

// Server-Sent Events stream of application changes for a user
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
      ? db.collection('applications').where('userId', '==', userId)
      : db.collection('applications').where('email', '==', email);

    const unsubscribe = query.onSnapshot(async snap => {
      try {
        const applications = await Promise.all(
          snap.docs.map(async d => {
            const app: any = { id: d.id, ...d.data() };
            const created = (app as any).createdAt?.toDate?.() || (app as any).createdAt;
            if (created instanceof Date) {
              (app as any).createdAt = created.toISOString();
            }
            if (app.bikeId) {
              const bikeDoc = await db.collection('bikes').doc(app.bikeId).get();
              app.bike = bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null;
            } else {
              app.bike = null;
            }
            return app;
          })
        );
        const payload = JSON.stringify({ success: true, applications });
        res.write(`data: ${payload}\n\n`);
      } catch (err: any) {
        res.write(`data: ${JSON.stringify({ success: false, error: err?.message || 'stream error' })}\n\n`);
      }
    });

    const keepAlive = setInterval(() => {
      res.write(': keep-alive\n\n');
    }, 25000);

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
      res.end();
    });
  } catch {
    res.status(500).end();
  }
});

export default router;


