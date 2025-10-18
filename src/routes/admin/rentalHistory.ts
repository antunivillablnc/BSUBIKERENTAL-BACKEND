import { Router } from 'express';
import { db } from '../../lib/firebase.js';

const router = Router();

router.get('/rental-history', async (_req, res) => {
  try {
    const rentalsSnap = await db.collection('rentalHistory').orderBy('createdAt', 'desc').get();
    const rentals = await Promise.all(rentalsSnap.docs.map(async d => {
      const r: any = { id: d.id, ...d.data() };
      const created = (r as any).createdAt?.toDate?.() || (r as any).createdAt;
      const start = (r as any).startDate?.toDate?.() || (r as any).startDate;
      const end = (r as any).endDate?.toDate?.() || (r as any).endDate;
      if (created instanceof Date) r.createdAt = created.toISOString();
      if (start instanceof Date) r.startDate = start.toISOString();
      if (end instanceof Date) r.endDate = end.toISOString();
      const userDoc = await db.collection('users').doc(r.userId).get();
      const bikeDoc = await db.collection('bikes').doc(r.bikeId).get();
      const appDoc = r.applicationId ? await db.collection('applications').doc(r.applicationId).get() : null;
      const bikeName = bikeDoc.exists ? ((bikeDoc.data() as any)?.name ?? null) : (r.bikeName ?? null);
      const college = (appDoc && appDoc.exists ? (appDoc.data() as any)?.college : undefined) ?? (userDoc.exists ? (userDoc.data() as any)?.college : undefined) ?? (r as any)?.college ?? null;
      return { ...r, bikeName, college, type: 'rental', status: 'Completed', user: userDoc.exists ? { id: userDoc.id, ...userDoc.data() } : null, bike: bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null, application: appDoc && appDoc.exists ? { id: appDoc.id, ...appDoc.data() } : null };
    }));
    const rejSnap = await db.collection('applications').where('status', '==', 'rejected').get();
    const mappedRejections = await Promise.all(rejSnap.docs.map(async aDoc => {
      const a: any = { id: aDoc.id, ...aDoc.data() };
      const created = (a as any).createdAt?.toDate?.() || (a as any).createdAt;
      const createdIso = created instanceof Date ? created.toISOString() : created;
      const userDoc = await db.collection('users').doc(a.userId).get();
      const college = (a as any)?.college ?? (userDoc.exists ? (userDoc.data() as any)?.college : undefined) ?? null;
      return { id: `rej-${a.id}`, startDate: null, endDate: null, createdAt: createdIso, college, user: userDoc.exists ? { id: userDoc.id, ...userDoc.data() } : null, bike: null, application: { id: a.id, firstName: a.firstName, lastName: a.lastName, email: a.email, college: (a as any)?.college ?? null }, type: 'rejected', status: 'Rejected' };
    }));
    const progSnap = await db.collection('applications').where('status', 'in', ['approved', 'assigned', 'active']).get();
    const mappedInProgress = await Promise.all(progSnap.docs.map(async aDoc => {
      const a: any = { id: aDoc.id, ...aDoc.data() };
      const created = (a as any).createdAt?.toDate?.() || (a as any).createdAt;
      const assigned = (a as any).assignedAt?.toDate?.() || (a as any).assignedAt;
      const createdIso = created instanceof Date ? created.toISOString() : created;
      const assignedIso = assigned instanceof Date ? assigned.toISOString() : assigned;
      const userDoc = await db.collection('users').doc(a.userId).get();
      const bikeDoc = a.bikeId ? await db.collection('bikes').doc(a.bikeId).get() : null;
      const college = (a as any)?.college ?? (userDoc.exists ? (userDoc.data() as any)?.college : undefined) ?? null;
      return { id: `app-${a.id}-${a.status}`, startDate: assignedIso || null, endDate: null, createdAt: assignedIso || createdIso, college, user: userDoc.exists ? { id: userDoc.id, ...userDoc.data() } : null, bike: bikeDoc && bikeDoc.exists ? { id: bikeDoc.id, ...bikeDoc.data() } : null, application: { id: a.id, firstName: a.firstName, lastName: a.lastName, email: a.email, college: (a as any)?.college ?? null }, type: 'rental', status: a.bikeId ? 'Rented' : 'Approved' };
    }));
    const history = [...rentals, ...mappedInProgress, ...mappedRejections].sort((a, b) => new Date(b.createdAt as any).getTime() - new Date(a.createdAt as any).getTime());
    res.json({ success: true, history });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load history' });
  }
});

export default router;


