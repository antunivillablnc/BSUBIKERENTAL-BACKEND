import { Router } from 'express';
import { db } from '../../lib/firebase.js';

const router = Router();

router.get('/users', async (_req, res) => {
  try {
    const snap = await db.collection('users').orderBy('createdAt', 'desc').get();
    res.json({ success: true, users: snap.docs.map((d: any) => ({ id: d.id, ...d.data() })) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load users' });
  }
});

router.post('/users', async (req, res) => {
  try {
    const { email, password, name, role } = req.body || {};
    if (!email || !password || !name || !role) return res.status(400).json({ success: false, error: 'All fields are required.' });
    const existingSnap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!existingSnap.empty) return res.status(400).json({ success: false, error: 'User with this email already exists.' });
    const bcrypt = await import('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 12);
    const userRef = await db.collection('users').add({ email, password: hashedPassword, name, role, createdAt: new Date() });
    const user = { id: userRef.id, email, name, role, createdAt: new Date() };
    if ((role || '').toLowerCase() !== 'admin') {
      try { await db.collection('leaderboard').add({ userId: user.id, name: name || email, distanceKm: 0, co2SavedKg: 0, createdAt: new Date(), updatedAt: new Date() }); } catch {}
    }
    await db.collection('activityLogs').add({ type: 'Create User', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Created user account for ${email}`, createdAt: new Date() });
    res.json({ success: true, user: { ...user, password: undefined } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to create user' });
  }
});

router.put('/users', async (req, res) => {
  try {
    const { id, email, name, role, password } = req.body || {};
    if (!id || !email || !name || !role) return res.status(400).json({ success: false, error: 'ID, email, name, and role are required.' });
    const existingDoc = await db.collection('users').doc(id).get();
    if (!existingDoc.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    const emailSnap = await db.collection('users').where('email', '==', email).get();
    const emailTaken = emailSnap.docs.some((d: any) => d.id !== id);
    if (emailTaken) return res.status(400).json({ success: false, error: 'Email is already taken by another user.' });
    const bcrypt = await import('bcryptjs');
    const updateData: any = { email, name, role };
    if (password) updateData.password = await bcrypt.hash(password, 12);
    await db.collection('users').doc(id).update(updateData);
    await db.collection('activityLogs').add({ type: 'Update User', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Updated user account for ${email}`, createdAt: new Date() });
    res.json({ success: true, user: { id, ...updateData, password: undefined } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update user' });
  }
});

router.delete('/users', async (req, res) => {
  try {
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'User ID is required.' });
    const existingDoc = await db.collection('users').doc(id).get();
    if (!existingDoc.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    await db.collection('users').doc(id).delete();
    await db.collection('activityLogs').add({ type: 'Delete User', adminName: 'Admin', adminEmail: 'admin@example.com', description: `Deleted user account for ${existingDoc.data()?.email}`, createdAt: new Date() });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to delete user' });
  }
});

export default router;


