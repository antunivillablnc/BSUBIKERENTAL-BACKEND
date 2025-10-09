import { Router } from 'express';
import { db } from '../lib/firebase.js';

const router = Router();

router.get('/', async (_req, res) => {
  const snap = await db.collection('reported_issues').orderBy('reportedAt', 'desc').get();
  const items = snap.docs.map(d => {
    const data = d.data() as any;
    const ra = data.reportedAt;
    const rza = data.resolvedAt;
    const reportedAt = ra && typeof ra.toDate === 'function'
      ? ra.toDate().toISOString()
      : ra instanceof Date
        ? ra.toISOString()
        : typeof ra === 'string'
          ? ra
          : null;
    const resolvedAt = rza && typeof rza.toDate === 'function'
      ? rza.toDate().toISOString()
      : rza instanceof Date
        ? rza.toISOString()
        : typeof rza === 'string'
          ? rza
          : null;
    return {
      id: d.id,
      ...data,
      reportedAt,
      resolvedAt,
    };
  });
  res.json(items);
});

router.post('/', async (req, res) => {
  const doc = await db.collection('reported_issues').add(req.body);
  res.status(201).json({ id: doc.id });
});

router.patch('/', async (req, res) => {
  const { id, ...rest } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  const update: Record<string, any> = { ...rest };
  if (update.reportedAt && typeof update.reportedAt === 'string') update.reportedAt = new Date(update.reportedAt);
  if (update.resolvedAt === null) update.resolvedAt = null;
  if (update.resolvedAt && typeof update.resolvedAt === 'string') update.resolvedAt = new Date(update.resolvedAt);
  await db.collection('reported_issues').doc(id).update(update);
  res.json({ ok: true });
});

export default router;


