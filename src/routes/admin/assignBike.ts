import { Router } from 'express';
import { db } from '../../lib/firebase.js';
import nodemailer from 'nodemailer';

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
    if (process.env.ENABLE_SMTP_IN_BACKEND === 'true') {
      try {
        const port = Number(process.env.EMAIL_PORT || 465);
        const transporter = nodemailer.createTransport({
          host: process.env.EMAIL_SERVER || 'smtp.gmail.com',
          port,
          secure: port === 465,
          auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
          tls: { rejectUnauthorized: false },
        });
        const bikeLabel = bike?.name || bike?.plateNumber || 'your assigned bike';
        const recipient = application.email;
        if (recipient) {
          await transporter.sendMail({ from: process.env.EMAIL_USER, to: recipient, subject: 'Your Bike Rental Application Has Been Accepted', text: `Good news! Your bike rental application has been accepted. The admin has assigned you bike ${bikeLabel}.`, html: `<p>Good news! Your bike rental application has been <strong>accepted</strong>.</p><p>The admin has assigned you bike <strong>${bikeLabel}</strong>.</p><p>Please check your dashboard for next steps and pickup instructions.</p>` });
        }
      } catch (e) { console.error('Failed to send assignment email:', e); }
    }
    await db.collection('activityLogs').add({ type: 'Assign Bike', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Assigned bike ID ${bikeId} to application ID ${applicationId}`, createdAt: new Date() });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to assign bike' });
  }
});

export default router;


