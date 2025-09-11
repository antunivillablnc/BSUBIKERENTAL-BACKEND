import { Router } from 'express';
import { db } from '../../lib/firebase';

const router = Router();

router.get('/activity-log', async (_req, res) => {
  try {
    const snap = await db.collection('activityLogs').orderBy('createdAt', 'desc').get();
    res.json(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  } catch (e) {
    res.status(500).json([]);
  }
});

export default router;


