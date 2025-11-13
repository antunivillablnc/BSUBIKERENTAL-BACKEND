import { Router } from 'express';
import { getMongoDb, toObjectId } from '../../lib/mongo.js';

const router = Router();

router.get('/users', async (_req, res) => {
  try {
    const db = await getMongoDb();
    const usersCol = db.collection('users');
    const docs = await usersCol
      .find({}, { projection: { password: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    const users = docs.map((d: any) => {
      const { _id, ...rest } = d;
      return { id: String(_id), ...rest };
    });
    res.json({ success: true, users });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load users' });
  }
});

router.post('/users', async (req, res) => {
  try {
    const db = await getMongoDb();
    const usersCol = db.collection('users');
    const { email, password, name, role } = req.body || {};
    if (!email || !password || !name || !role) {
      return res.status(400).json({ success: false, error: 'All fields are required.' });
    }

    const existing = await usersCol.findOne({ email });
    if (existing) return res.status(400).json({ success: false, error: 'User with this email already exists.' });

    const bcrypt = await import('bcryptjs');
    const hashedPassword = await bcrypt.hash(String(password), 12);
    const now = new Date();
    const insertRes = await usersCol.insertOne({ email, password: hashedPassword, name, role, createdAt: now });
    const user = { id: String(insertRes.insertedId), email, name, role, createdAt: now };

    if ((String(role) || '').toLowerCase() !== 'admin') {
      try {
        await db.collection('leaderboard').insertOne({
          userId: user.id,
          name: name || email,
          distanceKm: 0,
          co2SavedKg: 0,
          createdAt: now,
          updatedAt: now,
        });
      } catch {}
    }

    try {
      await db.collection('activityLogs').insertOne({
        type: 'Create User',
        adminName: 'Admin',
        adminEmail: 'admin@example.com',
        description: `Created user account for ${email}`,
        createdAt: now,
      });
    } catch {}

    res.json({ success: true, user });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to create user' });
  }
});

router.put('/users', async (req, res) => {
  try {
    const db = await getMongoDb();
    const usersCol = db.collection('users');
    const { id, email, name, role, password } = req.body || {};
    if (!id || !email || !name || !role) {
      return res.status(400).json({ success: false, error: 'ID, email, name, and role are required.' });
    }

    const _id = toObjectId(String(id));
    const existingDoc = await usersCol.findOne({ _id });
    if (!existingDoc) return res.status(404).json({ success: false, error: 'User not found.' });

    const emailOwner = await usersCol.findOne({ email });
    if (emailOwner && String(emailOwner._id) !== String(_id)) {
      return res.status(400).json({ success: false, error: 'Email is already taken by another user.' });
    }

    const bcrypt = await import('bcryptjs');
    const updateData: any = { email, name, role };
    if (password) updateData.password = await bcrypt.hash(String(password), 12);
    await usersCol.updateOne({ _id }, { $set: updateData });

    try {
      await db.collection('activityLogs').insertOne({
        type: 'Update User',
        adminName: 'Admin',
        adminEmail: 'admin@example.com',
        description: `Updated user account for ${email}`,
        createdAt: new Date(),
      });
    } catch {}

    res.json({ success: true, user: { id: String(_id), email, name, role } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to update user' });
  }
});

router.delete('/users', async (req, res) => {
  try {
    const db = await getMongoDb();
    const usersCol = db.collection('users');
    const { id } = req.body || {};
    if (!id) return res.status(400).json({ success: false, error: 'User ID is required.' });
    const _id = toObjectId(String(id));
    const existingDoc = await usersCol.findOne({ _id });
    if (!existingDoc) return res.status(404).json({ success: false, error: 'User not found.' });
    await usersCol.deleteOne({ _id });

    try {
      await db.collection('activityLogs').insertOne({
        type: 'Delete User',
        adminName: 'Admin',
        adminEmail: 'admin@example.com',
        description: `Deleted user account for ${existingDoc?.email}`,
        createdAt: new Date(),
      });
    } catch {}

    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to delete user' });
  }
});

export default router;


