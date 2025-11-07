import { Router } from 'express';
import { db } from '../../lib/firebase.js';

const router = Router();

// Basic handler for Resend webhooks (bounces/complaints)
router.post('/', async (req, res) => {
  try {
    const event = req.body || {};
    const type = String(event?.type || '').toLowerCase();
    const email = String(event?.data?.to || event?.to || '').trim();

    if (!email) return res.status(200).json({ ok: true });

    if (type.includes('bounce') || type.includes('complaint')) {
      // Mark email as suppressed in Firestore (best-effort)
      const snap = await db.collection('users').where('email', '==', email).limit(1).get();
      const doc = snap.docs[0];
      if (doc) {
        await db.collection('users').doc(doc.id).update({
          emailSuppressed: true,
          emailSuppressedAt: new Date(),
          emailSuppressedReason: type,
        });
      }
    }
    return res.status(200).json({ ok: true });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message || 'webhook error' });
  }
});

export default router;


