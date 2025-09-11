import { Router } from 'express';
import { db } from '../../lib/firebase';

const router = Router();

router.get('/applications', async (_req, res) => {
  try {
    const appsSnap = await db.collection('applications').orderBy('createdAt', 'desc').get();
    const applications = await Promise.all(appsSnap.docs.map(async d => {
      const app: any = { id: d.id, ...d.data() };
      if (app.bikeId) {
        const bikeDoc = await db.collection('bikes').doc(app.bikeId).get();
        app.bike = bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null;
      } else {
        app.bike = null;
      }
      return app;
    }));
    res.json({ success: true, applications });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load applications' });
  }
});

router.post('/applications', async (req, res) => {
  try {
    const { applicationId, status } = req.body || {};
    const allowed = ['approved', 'rejected', 'pending'];
    if (!allowed.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status.' });
    const appDoc = await db.collection('applications').doc(applicationId).get();
    if (!appDoc.exists) return res.status(404).json({ success: false, error: 'Application not found.' });
    const application: any = { id: appDoc.id, ...appDoc.data() };
    if ((application.status || '').toLowerCase() === 'completed' || (application.status || '').toLowerCase() === 'assigned') {
      return res.status(400).json({ success: false, error: 'Cannot change status of assigned or completed applications.' });
    }
    await db.collection('applications').doc(applicationId).update({ status });
    await db.collection('activityLogs').add({
      type: 'Update Application Status',
      adminName: 'Admin',
      adminEmail: 'admin@example.com',
      description: `Set application ${applicationId} status to ${status}`,
      createdAt: new Date(),
    });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update application' });
  }
});

export default router;


