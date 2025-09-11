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

export default router;


