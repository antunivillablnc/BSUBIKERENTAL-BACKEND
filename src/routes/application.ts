import { Router } from 'express';
import formidable, { File as FormidableFile, Fields, Files } from 'formidable';
import path from 'path';
import cloudinary from '../lib/cloudinary';
import { db } from '../lib/firebase';

const router = Router();

router.post('/', async (req, res) => {
  const form = formidable({ keepExtensions: true });
  try {
    const { fields, files } = await new Promise<{ fields: Fields; files: Files }>((resolve, reject) => {
      form.parse(req, (err, fields, files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const getString = (f: any) => (Array.isArray(f) ? String(f[0]) : f ? String(f) : undefined);
    const toFile = (f: any): FormidableFile | undefined => (Array.isArray(f) ? (f[0] as FormidableFile) : (f as FormidableFile));

    const userId = getString(fields.userId);
    if (!userId) {
      return res.status(401).json({ success: false, error: 'Please log in before submitting an application.' });
    }
    const existingSnap = await db.collection('applications').where('userId', '==', userId).get();
    const existing = existingSnap.docs
      .map(d => ({ id: d.id, ...(d.data() as any) }))
      .find(a => ['pending', 'approved', 'active', 'assigned'].includes(String(a.status || '').toLowerCase()));
    if (existing) return res.status(400).json({ success: false, error: 'You already have an active or pending rental application.' });

    // Ensure Cloudinary is configured
    const cloudinaryConfigured = Boolean(
      process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET
    );
    if (!cloudinaryConfigured) {
      return res.status(500).json({
        success: false,
        error: 'Cloudinary not configured. Please set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET in backend/.env',
      });
    }

    const uploadIfPresent = async (file: FormidableFile | undefined, folder: string) => {
      if (!file || !file.filepath || !file.originalFilename) return null;
      const publicId = path.parse(file.originalFilename).name;
      const upload = await cloudinary.uploader.upload(file.filepath, {
        folder,
        public_id: publicId,
        overwrite: true,
        resource_type: 'auto',
        type: 'upload',
      });
      return upload.secure_url;
    };

    const certificatePath = await uploadIfPresent(toFile(files.indigencyFile), 'bike-rental/certificates');
    const gwaDocumentPath = await uploadIfPresent(toFile(files.gwaFile), 'bike-rental/documents/gwa');
    const ecaDocumentPath = await uploadIfPresent(toFile(files.ecaFile), 'bike-rental/documents/eca');
    const itrDocumentPath = await uploadIfPresent(toFile(files.itrFile), 'bike-rental/documents/itr');

    const docRef = await db.collection('applications').add({
      lastName: getString(fields.lastName)!,
      firstName: getString(fields.firstName)!,
      middleName: getString(fields.middleName) || null,
      srCode: getString(fields.srCode)!,
      sex: getString(fields.sex)!,
      dateOfBirth: new Date(getString(fields.dateOfBirth)!),
      phoneNumber: getString(fields.phoneNumber)!,
      email: getString(fields.email)!,
      collegeProgram: getString(fields.collegeProgram) || null,
      college: getString(fields.college) || null,
      program: getString(fields.program) || null,
      gwaLastSemester: getString(fields.gwaLastSemester) || null,
      extracurricularActivities: getString(fields.extracurricularActivities) || null,
      houseNo: getString(fields.houseNo)!,
      streetName: getString(fields.streetName)!,
      barangay: getString(fields.barangay)!,
      municipality: getString(fields.municipality)!,
      province: getString(fields.province)!,
      distanceFromCampus: getString(fields.distanceFromCampus)!,
      familyIncome: getString(fields.familyIncome)!,
      intendedDuration: getString(fields.intendedDuration)!,
      intendedDurationOther: getString(fields.intendedDurationOther) || null,
      certificatePath,
      gwaDocumentPath,
      ecaDocumentPath,
      itrDocumentPath,
      userId: userId!,
      bikeId: null,
      status: 'pending',
      dueDate: null,
      assignedAt: null,
      createdAt: new Date(),
    });

    return res.json({ success: true, application: { id: docRef.id } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Upload failed' });
  }
});

export default router;


