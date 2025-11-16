import { Router } from 'express';
import { db } from '../../lib/firebase.js';
import { sendMail, renderBrandedEmail } from '../../lib/mailer.js';
import { requireAuth } from '../../middleware/auth.js';
import formidable, { File as FormidableFile, Fields, Files } from 'formidable';
import path from 'path';
import cloudinary from '../../lib/cloudinary.js';
import { getMongoDb } from '../../lib/mongo.js';

const router = Router();

router.get('/applications', requireAuth, async (req, res) => {
  try {
    const appsSnap = await db.collection('applications').orderBy('createdAt', 'desc').get();
    
    // Get MongoDB connection for evaluations
    const mdb = await getMongoDb();
    const evaluationsCollection = mdb.collection('evaluations');
    
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
      
      // Fetch evaluation from MongoDB
      try {
        const evalDoc = await evaluationsCollection.findOne({ applicationId: app.id });
        if (evalDoc) {
          // Convert MongoDB document to evaluation object (remove _id and applicationId)
          const { _id, applicationId, ...evaluation } = evalDoc;
          
          // Convert Date objects to ISO strings for metadata
          if (evaluation.createdAt instanceof Date) evaluation.createdAt = evaluation.createdAt.toISOString();
          if (evaluation.updatedAt instanceof Date) evaluation.updatedAt = evaluation.updatedAt.toISOString();
          
          app.evaluation = evaluation;
        } else {
          // Fallback to Firestore evaluation if MongoDB doesn't have it
          app.evaluation = app.evaluation || null;
        }
      } catch (evalError) {
        // If MongoDB fetch fails, fallback to Firestore evaluation
        console.warn(`[admin/applications] Failed to fetch evaluation from MongoDB for ${app.id}:`, evalError);
        app.evaluation = app.evaluation || null;
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
    const { applicationId, status, evaluation } = req.body || {};
    const appDoc = await db.collection('applications').doc(applicationId).get();
    if (!appDoc.exists) return res.status(404).json({ success: false, error: 'Application not found.' });
    const application: any = { id: appDoc.id, ...appDoc.data() };
    
    // Handle evaluation update
    if (evaluation !== undefined) {
      await db.collection('applications').doc(applicationId).update({ evaluation });
      await db.collection('activityLogs').add({
        type: 'Update Application Evaluation',
        adminName: 'Admin',
        adminEmail: 'admin@example.com',
        description: `Updated evaluation for application ${applicationId}`,
        createdAt: new Date(),
      });
      return res.json({ success: true });
    }
    
    // Handle status update
    if (status) {
      const allowed = ['approved', 'rejected', 'pending'];
      if (!allowed.includes(status)) return res.status(400).json({ success: false, error: 'Invalid status.' });
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
              ? `<p>We're sorry to inform you that your application was <strong>rejected</strong>.</p>`
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
      return res.json({ success: true });
    }
    
    return res.status(400).json({ success: false, error: 'Either status or evaluation must be provided.' });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update application' });
  }
});

router.post('/applications/evaluation', requireAuth, async (req, res) => {
  const form = formidable({ keepExtensions: true });
  try {
    const { fields, files } = await new Promise<{ fields: Fields; files: Files }>((resolve, reject) => {
      form.parse(req, (err: any, fields: Fields, files: Files) => {
        if (err) reject(err);
        else resolve({ fields, files });
      });
    });

    const getString = (f: any) => (Array.isArray(f) ? String(f[0]) : f ? String(f) : undefined);
    const toFile = (f: any): FormidableFile | undefined => (Array.isArray(f) ? (f[0] as FormidableFile) : (f as FormidableFile));

    const applicationId = getString(fields.applicationId);
    if (!applicationId) {
      return res.status(400).json({ success: false, error: 'Application ID is required.' });
    }

    const appDoc = await db.collection('applications').doc(applicationId).get();
    if (!appDoc.exists) {
      return res.status(404).json({ success: false, error: 'Application not found.' });
    }

    const evaluationStr = getString(fields.evaluation);
    if (!evaluationStr) {
      return res.status(400).json({ success: false, error: 'Evaluation data is required.' });
    }

    let evaluation: any;
    try {
      evaluation = JSON.parse(evaluationStr);
    } catch {
      return res.status(400).json({ success: false, error: 'Invalid evaluation data format.' });
    }

    // Upload signature files if present
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

    // Upload signature files
    const eligibilitySignaturePath = await uploadIfPresent(toFile(files.eligibilitySignatureFile), 'bike-rental/evaluations/signatures/eligibility');
    const rankingSignaturePath = await uploadIfPresent(toFile(files.rankingSignatureFile), 'bike-rental/evaluations/signatures/ranking');
    const healthSignaturePath = await uploadIfPresent(toFile(files.healthSignatureFile), 'bike-rental/evaluations/signatures/health');
    const approvedSignaturePath = await uploadIfPresent(toFile(files.approvedSignatureFile), 'bike-rental/evaluations/signatures/approved');
    const releasedSignaturePath = await uploadIfPresent(toFile(files.releasedSignatureFile), 'bike-rental/evaluations/signatures/released');

    // Update evaluation with signature paths if files were uploaded
    // Only update if a new file was uploaded (don't overwrite existing paths with null)
    if (eligibilitySignaturePath) evaluation.eligibilitySignaturePath = eligibilitySignaturePath;
    if (rankingSignaturePath) evaluation.rankingSignaturePath = rankingSignaturePath;
    if (healthSignaturePath) evaluation.healthSignaturePath = healthSignaturePath;
    if (approvedSignaturePath) evaluation.approvedSignaturePath = approvedSignaturePath;
    if (releasedSignaturePath) evaluation.releasedSignaturePath = releasedSignaturePath;

    // Ensure all fields are present (even if empty/null) to maintain complete data structure
    const completeEvaluation = {
      // Eligibility fields
      eligibilityStatus: evaluation.eligibilityStatus ?? null,
      eligibilityRemarks: evaluation.eligibilityRemarks ?? '',
      eligibilitySignatureName: evaluation.eligibilitySignatureName ?? '',
      eligibilitySignaturePath: evaluation.eligibilitySignaturePath ?? null,
      
      // Ranking fields
      rankingScore: evaluation.rankingScore ?? '',
      rankingRecommended: evaluation.rankingRecommended ?? null,
      rankingSignatureName: evaluation.rankingSignatureName ?? '',
      rankingSignaturePath: evaluation.rankingSignaturePath ?? null,
      
      // Health fields
      healthStatus: evaluation.healthStatus ?? null,
      healthRemarks: evaluation.healthRemarks ?? '',
      healthSignatureName: evaluation.healthSignatureName ?? '',
      healthSignaturePath: evaluation.healthSignaturePath ?? null,
      
      // Approved fields
      approvedSignatureName: evaluation.approvedSignatureName ?? '',
      approvedSignaturePath: evaluation.approvedSignaturePath ?? null,
      
      // Released fields
      releasedBikePlate: evaluation.releasedBikePlate ?? '',
      releasedSignatureName: evaluation.releasedSignatureName ?? '',
      releasedSignaturePath: evaluation.releasedSignaturePath ?? null,
      
      // Metadata
      applicationId: applicationId,
      updatedAt: new Date(),
      createdAt: evaluation.createdAt ? (evaluation.createdAt instanceof Date ? evaluation.createdAt : new Date(evaluation.createdAt)) : new Date(),
    };

    // Save evaluation to MongoDB
    const mdb = await getMongoDb();
    const evaluationsCollection = mdb.collection('evaluations');
    
    // Check if evaluation already exists
    const existingEval = await evaluationsCollection.findOne({ applicationId });
    
    if (existingEval) {
      // Update existing evaluation - use replaceOne to ensure all fields are updated
      await evaluationsCollection.replaceOne(
        { applicationId },
        completeEvaluation
      );
    } else {
      // Insert new evaluation
      await evaluationsCollection.insertOne(completeEvaluation);
    }
    
        // Use completeEvaluation for Firestore as well
        const { applicationId: _, ...evaluationForFirestore } = completeEvaluation; // Remove applicationId from Firestore (it's in the document ID)

    // Also update Firestore application document with evaluation reference (for backward compatibility)
    await db.collection('applications').doc(applicationId).update({ evaluation: evaluationForFirestore });
    
    // Log activity in Firestore
    await db.collection('activityLogs').add({
      type: 'Update Application Evaluation',
      adminName: 'Admin',
      adminEmail: 'admin@example.com',
      description: `Updated evaluation for application ${applicationId}`,
      createdAt: new Date(),
    });

    res.json({ success: true, evaluation: completeEvaluation });
  } catch (e: any) {
    console.error('[admin/applications/evaluation] error:', e);
    res.status(500).json({ success: false, error: e?.message || 'Failed to save evaluation' });
  }
});

export default router;


