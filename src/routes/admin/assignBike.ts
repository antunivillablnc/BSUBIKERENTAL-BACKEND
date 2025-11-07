import { Router } from 'express';
import { db } from '../../lib/firebase.js';
import { sendMail, renderBrandedEmail } from '../../lib/mailer.js';

const router = Router();

router.post('/assign-bike', async (req, res) => {
  try {
    const { applicationId, bikeId } = req.body || {};
    const appDoc = await db.collection('applications').doc(applicationId).get();
    const application: any = appDoc.exists ? { id: appDoc.id, ...appDoc.data() } : null;
    if (!application) return res.status(404).json({ success: false, error: 'Application not found.' });
    if (application.status === 'completed') return res.status(400).json({ success: false, error: 'This application has already been completed and cannot be reused.' });
    if (!['approved', 'assigned', 'active'].includes((application.status || '').toLowerCase())) return res.status(400).json({ success: false, error: 'Application must be approved before assigning a bike.' });
    if (application.bikeId) return res.status(400).json({ success: false, error: 'Application already has a bike assigned.' });
    const bikeDoc = await db.collection('bikes').doc(bikeId).get();
    const bike: any = bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null;
    if (!bike || bike.status !== 'available') return res.status(400).json({ success: false, error: 'Bike is not available.' });
    const batch = db.batch();
    batch.update(db.collection('applications').doc(applicationId), { bikeId, status: 'assigned', assignedAt: new Date() });
    batch.update(db.collection('bikes').doc(bikeId), { status: 'rented' });
    await batch.commit();
    // Send assignment email directly via Resend
    try {
      const bikeLabel = bike?.name || bike?.plateNumber || 'your assigned bike';
      let recipient = String(application.email || '').trim();
      if (!recipient) {
        const userId = String((application as any).userId || '').trim();
        if (userId) {
          const userDoc = await db.collection('users').doc(userId).get();
          const userData: any = userDoc.exists ? userDoc.data() : null;
          if (userData?.email) recipient = String(userData.email).trim();
        }
      }
      if (recipient) {
        const html = renderBrandedEmail({
          title: 'Application approved',
          intro: 'Good news! Your bike rental application has been accepted.',
          bodyHtml: `<p>The admin has assigned you bike <strong>${bikeLabel}</strong>.</p><p>Please go to Sustainable Development Office for your next steps and pickup instructions.</p>`,
        });
        await sendMail({
          to: recipient,
          subject: 'Your Bike Rental Application Has Been Accepted',
          text: `Good news! Your bike rental application has been accepted. Bike: ${bikeLabel}.`,
          html,
        });
      } else {
        if (process.env.NOTIFY_DEBUG === 'true') {
          console.warn('[assign-bike] no recipient email for', applicationId);
        }
      }
    } catch (e) { console.error('Failed to send assignment email:', e); }
    await db.collection('activityLogs').add({ type: 'Assign Bike', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Assigned bike ID ${bikeId} to application ID ${applicationId}`, createdAt: new Date() });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to assign bike' });
  }
});

export default router;


