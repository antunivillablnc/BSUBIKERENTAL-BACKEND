import { Router } from 'express';
import { db } from '../lib/firebase.js';
import { requireAuth, requireRole } from '../middleware/auth.js';

const router = Router();

router.get('/', requireRole('admin', 'teaching_staff'), async (_req, res) => {
  const snap = await db.collection('reported_issues').orderBy('reportedAt', 'desc').get();
  const items = snap.docs.map((d: any) => {
    const data = d.data() as any;
    const ra = data.reportedAt;
    const rza = data.resolvedAt;
    const reportedAt = ra && typeof ra.toDate === 'function'
      ? ra.toDate().toISOString()
      : ra instanceof Date
        ? ra.toISOString()
        : typeof ra === 'string'
          ? ra
          : null;
    const resolvedAt = rza && typeof rza.toDate === 'function'
      ? rza.toDate().toISOString()
      : rza instanceof Date
        ? rza.toISOString()
        : typeof rza === 'string'
          ? rza
          : null;
    return {
      id: d.id,
      ...data,
      reportedAt,
      resolvedAt,
    };
  });
  res.json(items);
});

const allowedCategories = new Set(['technical', 'bike_damage', 'safety', 'other']);
const allowedPriorities = new Set(['low', 'medium', 'high']);
const allowedStatuses = new Set(['open', 'in_progress', 'resolved', 'closed']);

router.post('/', requireAuth, async (req, res) => {
  try {
    const { subject, message, category, priority, imageUrl, bikeId, bikeName } = req.body || {};

    const normalizedSubject = typeof subject === 'string' ? subject.trim() : '';
    const normalizedMessage = typeof message === 'string' ? message.trim() : '';
    const normalizedCategory = typeof category === 'string' ? category : 'other';
    const normalizedPriority = typeof priority === 'string' ? priority : 'medium';
    const normalizedBikeId = typeof bikeId === 'string' && bikeId.trim() ? bikeId.trim() : null;
    const normalizedBikeName = typeof bikeName === 'string' && bikeName.trim() ? bikeName.trim() : null;

    if (!normalizedSubject) return res.status(400).json({ success: false, error: 'subject is required' });
    if (!normalizedMessage) return res.status(400).json({ success: false, error: 'message is required' });
    if (!allowedCategories.has(normalizedCategory)) return res.status(400).json({ success: false, error: 'invalid category' });
    if (!allowedPriorities.has(normalizedPriority)) return res.status(400).json({ success: false, error: 'invalid priority' });

    const now = new Date();
    const reporterEmail = (req.user as any)?.email || 'unknown';

    // Lookup reporter name from users collection
    let reportedByName: string | null = null;
    try {
      if (reporterEmail && reporterEmail !== 'unknown') {
        const userSnap = await db.collection('users').where('email', '==', reporterEmail).limit(1).get();
        const userDoc = userSnap.docs[0];
        const userData: any = userDoc ? userDoc.data() : null;
        if (userData && typeof userData.name === 'string' && userData.name.trim()) {
          reportedByName = userData.name.trim();
        }
      }
    } catch {}
    // If bikeId not provided but bikeName is, resolve to Firestore bike id by name (case-insensitive)
    let resolvedBikeId: string | null = normalizedBikeId;
    if (!resolvedBikeId && normalizedBikeName) {
      try {
        const nameLower = normalizedBikeName.toLowerCase();
        const bikesSnap = await db.collection('bikes').get();
        const match = bikesSnap.docs.find((d: any) => String((d.data() as any)?.name || '').toLowerCase().trim() === nameLower);
        if (match) resolvedBikeId = match.id;
      } catch {}
    }

    const record = {
      subject: normalizedSubject,
      message: normalizedMessage,
      category: normalizedCategory,
      priority: normalizedPriority,
      status: 'open',
      imageUrl: typeof imageUrl === 'string' && imageUrl ? imageUrl : null,
      reportedBy: reporterEmail,
      reportedByName,
      reportedAt: now,
      assignedTo: null,
      resolvedAt: null,
      adminNotes: '',
      bikeId: resolvedBikeId,
    } as const;

    const doc = await db.collection('reported_issues').add(record as any);
    res.status(201).json({ success: true, id: doc.id });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to create report' });
  }
});

router.patch('/', requireRole('admin', 'teaching_staff'), async (req, res) => {
  const { id, status, adminNotes, resolvedAt, assignedTo, priority } = req.body || {};
  if (!id) return res.status(400).json({ success: false, error: 'id required' });

  const update: Record<string, any> = {};
  if (typeof adminNotes === 'string') update.adminNotes = adminNotes;
  if (typeof assignedTo === 'string' || assignedTo === null) update.assignedTo = assignedTo ?? null;
  if (typeof status === 'string') {
    if (!allowedStatuses.has(status)) return res.status(400).json({ success: false, error: 'invalid status' });
    update.status = status;
  }
  if (typeof priority === 'string') {
    if (!allowedPriorities.has(priority)) return res.status(400).json({ success: false, error: 'invalid priority' });
    update.priority = priority;
  }
  if (resolvedAt === null) update.resolvedAt = null;
  else if (typeof resolvedAt === 'string') update.resolvedAt = new Date(resolvedAt);

  await db.collection('reported_issues').doc(id).update(update);
  // Create in-app notification for reporter
  try {
    const docRef = db.collection('reported_issues').doc(String(id));
    const snap = await docRef.get();
    const data: any = snap.exists ? snap.data() : null;
    const userEmail: string | undefined = data?.reportedBy;
    const userId: string | undefined = data?.userId || undefined;
    const subject: string = data?.subject || 'Reported issue';
    const prettyStatus = String(update.status || data?.status || '').replace('_', ' ').toUpperCase();
    const notes = typeof update.adminNotes === 'string' ? update.adminNotes : data?.adminNotes || '';
    if (userEmail) {
      await db.collection('notifications').add({
        userEmail,
        userId: userId || null,
        type: 'issue_update',
        title: 'Issue Update',
        message: `Your issue "${subject}" is now ${prettyStatus}. ${notes ? 'Notes: '+notes : ''}`.trim(),
        status: update.status || data?.status || 'updated',
        metadata: { issueId: id, subject, notes },
        createdAt: new Date(),
        read: false,
      });
    }
  } catch (e) {
    console.error('Failed to create issue notification:', e);
  }
  // Email notification removed

  res.json({ success: true });
});

export default router;


