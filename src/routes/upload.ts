import { Router } from 'express';
import formidable, { File as FormidableFile } from 'formidable';
import cloudinary from '../lib/cloudinary';

const router = Router();

router.post('/', async (req, res) => {
  const form = formidable({ keepExtensions: true });
  try {
    const { files } = await new Promise<{ files: formidable.Files }>((resolve, reject) => {
      form.parse(req, (err, _fields, files) => {
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

    return res.json({ success: true, photoUrl: (result as any).secure_url });
  } catch (e: any) {
    console.error('Profile photo upload error:', e);
    return res.status(500).json({ error: e?.message || 'Failed to upload photo' });
  }
});

export default router;


