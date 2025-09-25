import { Router } from 'express';
import bcrypt from 'bcryptjs';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { db } from '../lib/firebase';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password, recaptchaToken } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    // Optional: verify reCAPTCHA server-side
    if (process.env.RECAPTCHA_SECRET_KEY) {
      if (!recaptchaToken) return res.status(400).json({ error: 'Missing reCAPTCHA token' });
      const verifyBody = `secret=${encodeURIComponent(process.env.RECAPTCHA_SECRET_KEY)}&response=${encodeURIComponent(recaptchaToken)}`;
      const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: verifyBody,
      });
      const verifyData = await verifyRes.json();
      if (!verifyData?.success) return res.status(400).json({ error: 'reCAPTCHA verification failed' });
    }

    const userSnap = await db.collection('users').where('email', '==', username).limit(1).get();
    const userDoc = userSnap.docs[0];
    const user: any = userDoc ? { id: userDoc.id, ...userDoc.data() } : null;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    if (user.role === 'admin') {
      await db.collection('activityLogs').add({
        type: 'Login',
        adminName: user.name || '',
        adminEmail: user.email,
        description: 'Admin logged in',
        createdAt: new Date(),
      });
    }

    if(user.role === 'teaching_staff' && 'non_teaching_staff')
    {
      await db.collection('activityLogs').add({
        type: 'Login',
        adminName: user.name || '',
        adminEmail: user.email,
        description: 'Staff logged in',
        createdAt: new Date(),
      });
    }

    return res.json({ message: 'Login successful', user: { id: user.id, email: user.email, role: user.role, name: user.name } });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Login failed' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body || {};
    if (!fullName || !email || !password || !role) return res.status(400).json({ error: 'All fields are required' });
    const normalizedRole = String(role).toLowerCase();

    const existingSnap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!existingSnap.empty) return res.status(409).json({ error: 'Email already registered' });

    const hashed = await bcrypt.hash(password, 10);
    await db.collection('users').add({
      name: fullName,
      email,
      password: hashed,
      role: normalizedRole,
      createdAt: new Date(),
    });
    return res.json({ message: 'Registration successful' });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Registration failed' });
  }
});

// Request password reset
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const userSnap = await db.collection('users').where('email', '==', String(email)).limit(1).get();
    const userDoc = userSnap.docs[0];
    const user: any = userDoc ? { id: userDoc.id, ...userDoc.data() } : null;

    // Always return success (don’t reveal if email exists)
    if (!user) return res.json({ message: 'If this email is registered, a reset link has been sent.' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiry = new Date(Date.now() + 1000 * 60 * 60); // 1 hour
    await db.collection('users').doc(user.id).update({ passwordResetToken: token, passwordResetExpiry: expiry });

    const baseUrl = process.env.FRONTEND_BASE_URL || 'http://localhost:3000';
    const resetLink = `${baseUrl.replace(/\/$/, '')}/reset-password?token=${token}`;

    const mailPort = Number(process.env.EMAIL_PORT || 465);
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_SERVER || 'smtp.gmail.com',
      port: mailPort,
      secure: mailPort === 465,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false },
    });
    try {
      await transporter.sendMail({
        from: process.env.EMAIL_USER,
        to: user.email,
        subject: 'Password Reset',
        text: `Reset your password: ${resetLink}`,
        html: `<p>Click the link to reset your password:</p><p><a href="${resetLink}">${resetLink}</a></p>`,
      });
    } catch (e) {
      // Log but still return generic success
      console.error('Failed to send reset email:', e);
    }
    return res.json({ message: 'If this email is registered, a reset link has been sent.' });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to process request' });
  }
});

// Complete password reset
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body || {};
    if (!token || !password) return res.status(400).json({ error: 'Token and password are required' });

    const snap = await db.collection('users').where('passwordResetToken', '==', String(token)).limit(1).get();
    const doc = snap.docs[0];
    const user: any = doc ? { id: doc.id, ...doc.data() } : null;
    const expiry = user?.passwordResetExpiry?.toDate?.() || user?.passwordResetExpiry;
    if (!user || !expiry || new Date(expiry).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }
    const hashed = await bcrypt.hash(String(password), 10);
    await db.collection('users').doc(user.id).update({
      password: hashed,
      passwordResetToken: null,
      passwordResetExpiry: null,
    });
    return res.json({ message: 'Password has been reset. You can now log in.' });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to reset password' });
  }
});

export default router;


