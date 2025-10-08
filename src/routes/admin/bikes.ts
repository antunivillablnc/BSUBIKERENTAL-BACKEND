import { Router } from 'express';
import { db } from '../../lib/firebase';
import { requireAuth } from '../../middleware/auth';

const router = Router();

router.get('/bikes', requireAuth, async (_req, res) => {
  try {
    const bikeSnap = await db.collection('bikes').get();
    const bikes = await Promise.all(bikeSnap.docs.map(async d => {
      const bike: any = { id: d.id, ...d.data() };
      const created = (bike as any).createdAt?.toDate?.() || (bike as any).createdAt;
      if (created instanceof Date) bike.createdAt = created.toISOString();
      const appsSnap = await db.collection('applications').where('bikeId', '==', bike.id).get();
      const apps = appsSnap.docs.map(a => ({ id: a.id, ...a.data() }));
      apps.sort((a: any, b: any) => {
        const ad = (a.createdAt?.toDate?.() ?? new Date(a.createdAt ?? 0)) as Date;
        const bd = (b.createdAt?.toDate?.() ?? new Date(b.createdAt ?? 0)) as Date;
        return bd.getTime() - ad.getTime();
      });
      bike.applications = apps;
      return bike;
    }));
    bikes.sort((a: any, b: any) => {
      const ad = (a.createdAt?.toDate?.() ?? new Date(a.createdAt ?? 0)) as Date;
      const bd = (b.createdAt?.toDate?.() ?? new Date(b.createdAt ?? 0)) as Date;
      return bd.getTime() - ad.getTime();
    });
    res.json({ success: true, bikes });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load bikes' });
  }
});

router.post('/bikes', requireAuth, async (req, res) => {
  try {
    const data = req.body || {};
    if (!data.name || typeof data.name !== 'string' || !data.name.trim()) return res.status(400).json({ success: false, error: 'Plate number is required.' });
    const status = data.status === 'rented' ? 'rented' : 'available';
    const dupSnap = await db.collection('bikes').where('name', '==', data.name.trim()).limit(1).get();
    if (!dupSnap.empty) return res.status(400).json({ success: false, error: 'A bike with this plate number already exists.' });
    const bikeRef = await db.collection('bikes').add({ name: data.name.trim(), status, createdAt: new Date() });
    await db.collection('activityLogs').add({ type: 'Add Bike', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Added bike ${data.name.trim()} to inventory`, createdAt: new Date() });
    res.json({ success: true, bike: { id: bikeRef.id, name: data.name.trim(), status } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to add bike' });
  }
});

router.patch('/bikes', requireAuth, async (req, res) => {
  try {
    const { id, status } = req.body || {};
    if (!id || !status) return res.status(400).json({ success: false, error: 'Bike id and status are required.' });
    if (status === 'available') {
      const activeAppsSnap = await db.collection('applications').where('bikeId', '==', id).get();
      const activeApps = activeAppsSnap.docs.map(d => ({ id: d.id, ...d.data() })) as any[];
      if (activeApps.length > 0) {
        const now = new Date();
        for (const app of activeApps) {
          if (app.bikeId) {
            await db.collection('rentalHistory').add({ applicationId: app.id, userId: app.userId, bikeId: app.bikeId, startDate: app.assignedAt ?? app.createdAt, endDate: now, createdAt: new Date() });
          }
        }
        const batch = db.batch();
        activeAppsSnap.docs.forEach(doc => { batch.update(doc.ref, { bikeId: null, status: 'completed' }); });
        await batch.commit();
      }
    }
    await db.collection('bikes').doc(id).update({ status });
    await db.collection('activityLogs').add({ type: 'Update Bike Status', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Updated bike ID ${id} status to ${status}`, createdAt: new Date() });
    const bikeDoc = await db.collection('bikes').doc(id).get();
    res.json({ success: true, bike: { id, ...bikeDoc.data() } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update bike' });
  }
});

router.delete('/bikes', requireAuth, async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'Bike id is required.' });
    await db.collection('bikes').doc(id).delete();
    await db.collection('activityLogs').add({ type: 'Delete Bike', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Deleted bike ID ${id} from inventory`, createdAt: new Date() });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to delete bike' });
  }
});

export default router;


