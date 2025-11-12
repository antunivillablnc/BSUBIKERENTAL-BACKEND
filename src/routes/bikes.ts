import { Router } from 'express';
import { db } from '../lib/firebase.js';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const bikesSnap = await db.collection('bikes').orderBy('name').get();
    const bikes = bikesSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
    const bikesWithLatestApp = await Promise.all(
      bikes.map(async (bike: any) => {
        const appsSnap = await db.collection('applications').where('bikeId', '==', bike.id).get();
        const apps = appsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));
        apps.sort((a: any, b: any) => {
          const ad = (a.createdAt?.toDate?.() ?? new Date(a.createdAt ?? 0)) as Date;
          const bd = (b.createdAt?.toDate?.() ?? new Date(b.createdAt ?? 0)) as Date;
          return bd.getTime() - ad.getTime();
        });
        const applications = apps.slice(0, 1);
        return { ...bike, applications };
      })
    );
    res.json({ success: true, bikes: bikesWithLatestApp });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load bikes' });
  }
});

// Fetch a single bike by id (public, no auth). Returns id, name, deviceId fields.
router.get('/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id required' });
    const doc = await db.collection('bikes').doc(id).get();
    if (!doc.exists) return res.status(404).json({ success: false, error: 'not found' });
    const data: any = { id: doc.id, ...doc.data() };
    const deviceId = data?.DEVICE_ID || data?.deviceId || null;
    res.json({ success: true, bike: { id: doc.id, name: data?.name || null, deviceId } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load bike' });
  }
});

export default router;


