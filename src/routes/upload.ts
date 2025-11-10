import { Router } from 'express';
import formidable, { File as FormidableFile, Fields, Files } from 'formidable';
import cloudinary from '../lib/cloudinary.js';
import { requireAuth } from '../middleware/auth.js';
import { db } from '../lib/firebase.js';

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  const form = formidable({ keepExtensions: true });
  try {
    const { files } = await new Promise<{ files: Files }>((resolve, reject) => {
      form.parse(req, (err: any, _fields: Fields, files: Files) => {
        if (err) reject(err);
        else resolve({ files });
      });
    });

    let photo: FormidableFile | undefined;
    const raw = (files as any).photo as FormidableFile | FormidableFile[] | undefined;
    if (Array.isArray(raw)) photo = raw[0];
    else photo = raw as FormidableFile | undefined;

    if (!photo || !photo.filepath) {
      return res.status(400).json({ error: 'No photo provided' });
    }

    const result = await cloudinary.uploader.upload(photo.filepath, {
      folder: 'bike-rental/profile-photos',
      resource_type: 'auto',
      transformation: [
        { width: 400, height: 400, crop: 'fill', gravity: 'face' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });

    const secureUrl = (result as any).secure_url as string;

    // Attempt to persist the URL on the authenticated user's profile
    try {
      const authUser: any = (req as any).user || {};
      const userId: string = String(authUser?.id || '');
      const userEmail: string = String(authUser?.email || '');

      let updated = false;
      if (userId) {
        await db.collection('users').doc(userId).update({ photo: secureUrl, updatedAt: new Date() });
        updated = true;
      }
      if (!updated && userEmail) {
        const snap = await db.collection('users').where('email', '==', userEmail).limit(1).get();
        const doc = (snap as any).docs?.[0];
        if (doc?.id) {
          await db.collection('users').doc(doc.id).update({ photo: secureUrl, updatedAt: new Date() });
          updated = true;
        }
      }
      if (!updated) {
        console.warn('[upload-profile-photo] Could not locate user document to update photo for', { userId, userEmail });
      }
    } catch (persistErr) {
      console.error('[upload-profile-photo] Failed to persist photo URL on user record:', persistErr);
      // Do not fail the upload; return photo URL so client can still use it
    }

    return res.json({ success: true, photoUrl: secureUrl });
  } catch (e: any) {
    console.error('Profile photo upload error:', e);
    return res.status(500).json({ error: e?.message || 'Failed to upload photo' });
  }
});

export default router;


