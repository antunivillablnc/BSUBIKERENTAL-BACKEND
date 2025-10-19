import { Router } from 'express';
import formidable, { File as FormidableFile, Fields, Files } from 'formidable';
import cloudinary from '../lib/cloudinary.js';

const router = Router();

router.post('/', async (req, res) => {
  const form = formidable({ keepExtensions: true });
  try {
    const { files } = await new Promise<{ files: Files }>((resolve, reject) => {
      form.parse(req, (err: any, _fields: Fields, files: Files) => {
        if (err) reject(err);
        else resolve({ files });
      });
    });

    // Support field names 'file', 'image', or 'photo'
    const candidates = [
      (files as any).file,
      (files as any).image,
      (files as any).photo,
    ] as Array<FormidableFile | FormidableFile[] | undefined>;

    let uploadFile: FormidableFile | undefined;
    for (const c of candidates) {
      if (!c) continue;
      uploadFile = Array.isArray(c) ? c[0] : c;
      if (uploadFile) break;
    }

    if (!uploadFile || !uploadFile.filepath) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const result = await cloudinary.uploader.upload(uploadFile.filepath, {
      folder: 'bike-rental/issue-reports',
      resource_type: 'auto',
      transformation: [
        { width: 1600, height: 1600, crop: 'limit' },
        { quality: 'auto', fetch_format: 'auto' },
      ],
    });

    return res.json({ success: true, imageUrl: (result as any).secure_url });
  } catch (e: any) {
    console.error('Issue image upload error:', e);
    return res.status(500).json({ error: e?.message || 'Failed to upload issue image' });
  }
});

export default router;


