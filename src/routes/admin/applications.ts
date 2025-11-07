import { Router } from 'express';
import { db } from '../../lib/firebase.js';
import { sendMail, renderBrandedEmail } from '../../lib/mailer.js';
import { requireAuth } from '../../middleware/auth.js';

const router = Router();

router.get('/applications', requireAuth, async (req, res) => {
  try {
    const appsSnap = await db.collection('applications').orderBy('createdAt', 'desc').get();
    const applications = await Promise.all(appsSnap.docs.map(async (d: any) => {
      const app: any = { id: d.id, ...d.data() };
      // Convert createdAt to ISO string
      const created = (app as any).createdAt?.toDate?.() || (app as any).createdAt;
      if (created instanceof Date) app.createdAt = created.toISOString();
      
      // Convert dateOfBirth to ISO string
      const dateOfBirth = (app as any).dateOfBirth?.toDate?.() || (app as any).dateOfBirth;
      if (dateOfBirth instanceof Date) app.dateOfBirth = dateOfBirth.toISOString();
      
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
    console.error('[admin/applications] load error:', e);
    res.status(500).json({ success: false, error: e?.message || 'Failed to load applications' });
  }
});

router.post('/applications', requireAuth, async (req, res) => {
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
    // Send status email directly via Resend
    try {
      let recipient = String(application.email || '').trim();
      if (!recipient) {
        // Fallback to user's email if application email missing
        const userId = String((application as any).userId || '').trim();
        if (userId) {
          const userDoc = await db.collection('users').doc(userId).get();
          const userData: any = userDoc.exists ? userDoc.data() : null;
          if (userData?.email) recipient = String(userData.email).trim();
        }
      }
      if (recipient) {
        const subject = status === 'approved'
          ? 'Your Bike Rental Application Has Been Approved'
          : status === 'rejected'
            ? 'Your Bike Rental Application Status'
            : 'Your Bike Rental Application Status Updated';
        const bodyHtml = status === 'approved'
          ? `<p>Your bike rental application has been <strong>approved</strong>.</p><p>We will contact you with next steps.</p>`
          : status === 'rejected'
            ? `<p>We’re sorry to inform you that your application was <strong>rejected</strong>.</p>`
            : `<p>Your application status is now: <strong>${status}</strong>.</p>`;
        const html = renderBrandedEmail({ title: 'Application status updated', bodyHtml });
        await sendMail({ to: recipient, subject, html });
      } else {
        if (process.env.NOTIFY_DEBUG === 'true') {
          console.warn('[applications] no recipient email for', applicationId);
        }
      }
    } catch (e) {
      console.error('Failed to send status email:', e);
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update application' });
  }
});

export default router;


