import { Router } from 'express';
import { db } from '../../lib/firebase.js';
import { sendMail } from '../../lib/mailer.js';

const router = Router();

router.post('/end-rental', async (req, res) => {
  try {
    const { applicationId } = req.body || {};
    if (!applicationId) return res.status(400).json({ success: false, error: 'applicationId is required' });
    const appDoc = await db.collection('applications').doc(applicationId).get();
    const application: any = appDoc.exists ? { id: appDoc.id, ...appDoc.data() } : null;
    if (!application || !application.bikeId) return res.status(400).json({ success: false, error: 'No active rental for this application' });
    const now = new Date();
    const batch = db.batch();
    const startDate = application.assignedAt || application.createdAt;
    const histRef = db.collection('rentalHistory').doc();
    const bikeDoc = await db.collection('bikes').doc(application.bikeId).get();
    const bikeData: any = bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null;
    const bikeName = bikeData?.name || null;
    batch.set(histRef, { applicationId: application.id, userId: application.userId, bikeId: application.bikeId, bikeName, startDate, endDate: now, createdAt: new Date() });
    batch.update(db.collection('applications').doc(application.id), { bikeId: null, status: 'completed' });
    batch.update(db.collection('bikes').doc(application.bikeId), { status: 'available' });
    await batch.commit();
    await db.collection('activityLogs').add({ type: 'End Rental', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Ended rental for application ${application.id} and bike ${application.bikeId}`, createdAt: new Date() });

    // Send end-of-rental email
    try {
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
        const start = (startDate as any)?.toDate?.() || startDate;
        const end = now;
        const startStr = start instanceof Date ? start.toLocaleString() : String(start);
        const endStr = end.toLocaleString();
        const bikeLabel = bikeName || application.bikeId;
        await sendMail({
          to: recipient,
          subject: 'Your Bike Rental Has Ended',
          html: `<p>Your bike rental session has <strong>ended</strong>.</p>
                 <p><strong>Bike:</strong> ${bikeLabel || 'N/A'}</p>
                 <p><strong>Start:</strong> ${startStr}<br/><strong>End:</strong> ${endStr}</p>
                 <p>Thank you for using the University Bike Rental.</p>`,
          text: `Your bike rental session has ended.
Bike: ${bikeLabel || 'N/A'}
Start: ${startStr}
End: ${endStr}
Thank you for using the University Bike Rental.`,
        });
      }
    } catch (e) {
      console.error('[end-rental] failed to send email:', e);
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to end rental' });
  }
});

export default router;


