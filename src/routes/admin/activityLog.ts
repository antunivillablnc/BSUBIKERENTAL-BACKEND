import { Router } from 'express';
import { db } from '../../lib/firebase.js';

const router = Router();

router.get('/activity-log', async (_req, res) => {
  try {
    const snap = await db.collection('activityLogs').orderBy('createdAt', 'desc').get();
    const rows = snap.docs.map((d: any) => {
      const row: any = { id: d.id, ...d.data() };
      const created = (row as any).createdAt?.toDate?.() || (row as any).createdAt;
      if (created instanceof Date) row.createdAt = created.toISOString();
      return row;
    });
    res.json(rows);
  } catch (e) {
    res.status(500).json([]);
  }
});

export default router;


