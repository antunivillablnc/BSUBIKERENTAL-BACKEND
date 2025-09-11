import { Router } from 'express';
import { db } from '../lib/firebase';

const router = Router();

router.get('/', async (_req, res) => {
  try {
    const bikesSnap = await db.collection('bikes').orderBy('name').get();
    const bikes = bikesSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    const bikesWithLatestApp = await Promise.all(
      bikes.map(async (bike: any) => {
        const appsSnap = await db.collection('applications').where('bikeId', '==', bike.id).get();
        const apps = appsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
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

export default router;


