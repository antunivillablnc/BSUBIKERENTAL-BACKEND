import { Router } from 'express';
import { db } from '../lib/firebase';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const limit = Math.max(1, Math.min(100, Number(_req.query.limit) || 10));

    try {
      const usersSnap = await db.collection('users').get();
      const users = usersSnap.docs
        .map(d => ({ id: d.id, ...d.data() } as any))
        .filter(u => (u.role || '').toLowerCase() !== 'admin');
      const existingSnap = await db.collection('leaderboard').select('userId').get();
      const existingSet = new Set(existingSnap.docs.map(d => (d.data() as any).userId || ''));
      const toCreate = users.filter(u => !existingSet.has(u.id));
      if (toCreate.length) {
        const batch = db.batch();
        toCreate.forEach(u => {
          const ref = db.collection('leaderboard').doc();
          batch.set(ref, {
            userId: u.id,
            name: u.name || u.email,
            distanceKm: 0,
            co2SavedKg: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        });
        await batch.commit();
      }
    } catch {}

    const snap = await db.collection('leaderboard').orderBy('distanceKm', 'desc').get();
    const entries = snap.docs
      .map(d => ({ id: d.id, ...d.data() } as any))
      .sort((a, b) => {
        if (b.distanceKm !== a.distanceKm) return b.distanceKm - a.distanceKm;
        if (b.co2SavedKg !== a.co2SavedKg) return b.co2SavedKg - a.co2SavedKg;
        const ad = (a.createdAt?.toDate?.() ?? new Date(a.createdAt ?? 0)) as Date;
        const bd = (b.createdAt?.toDate?.() ?? new Date(b.createdAt ?? 0)) as Date;
        return bd.getTime() - ad.getTime();
      })
      .slice(0, limit);

    res.json({ success: true, entries });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load leaderboard' });
  }
});

router.post('/', async (req, res) => {
  try {
    const { name, distanceKm, co2SavedKg, userId } = req.body || {};
    if (!name || typeof distanceKm !== 'number' || typeof co2SavedKg !== 'number') {
      return res.status(400).json({ success: false, error: 'name, distanceKm, and co2SavedKg are required.' });
    }
    const ref = await db.collection('leaderboard').add({
      name,
      distanceKm,
      co2SavedKg,
      userId: userId || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.json({ success: true, entry: { id: ref.id, name, distanceKm, co2SavedKg, userId: userId || null } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to create entry' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { id, name, distanceKm, co2SavedKg } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'id is required.' });
    const data: any = { updatedAt: new Date() };
    if (typeof name === 'string') data.name = name;
    if (typeof distanceKm === 'number') data.distanceKm = distanceKm;
    if (typeof co2SavedKg === 'number') data.co2SavedKg = co2SavedKg;
    await db.collection('leaderboard').doc(id).update(data);
    const doc = await db.collection('leaderboard').doc(id).get();
    res.json({ success: true, entry: { id, ...doc.data() } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update entry' });
  }
});

export default router;


