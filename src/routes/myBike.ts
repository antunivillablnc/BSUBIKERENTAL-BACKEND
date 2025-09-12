import { Router } from 'express';
import { db } from '../lib/firebase';

const router = Router();

router.get('/', async (req, res) => {
  try {
    const userId = String(req.query.userId || '');
    if (!userId) return res.status(400).json({ success: false, error: 'User ID is required.' });
    const appSnap = await db
      .collection('applications')
      .where('userId', '==', userId)
      .where('bikeId', '!=', null)
      .where('status', 'in', ['approved', 'active', 'Assigned'])
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();
    const appDoc = appSnap.docs[0];
    const application: any = appDoc ? { id: appDoc.id, ...appDoc.data() } : null;
    if (application) {
      const created = (application as any).createdAt?.toDate?.() || (application as any).createdAt;
      if (created instanceof Date) application.createdAt = created.toISOString();
    }
    if (!application || !application.bikeId) return res.status(404).json({ success: false, error: 'No rented bike found for this user.' });
    const bikeDoc = await db.collection('bikes').doc(application.bikeId).get();
    const bike = bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null;
    if (!bike) return res.status(404).json({ success: false, error: 'Bike not found.' });
    res.json({ success: true, bike, application: { id: application.id, createdAt: application.createdAt } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load current bike' });
  }
});

export default router;


