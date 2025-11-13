import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { sendMail, renderBrandedEmail } from '../lib/mailer.js';
import { createRegistrationToken, createVerifyEmailToken, verifyRegistrationToken, verifyVerifyEmailToken } from '../lib/tokens.js';
import crypto from 'node:crypto';
import { db } from '../lib/firebase.js';
import { validatePassword } from '../lib/password.js';
import { issueJwt, requireAuth } from '../middleware/auth.js';
import { getMongoDb } from '../lib/mongo.js';

const router = Router();

router.post('/login', async (req, res) => {
  try {
    const { username, password, recaptchaToken } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    // Only verify reCAPTCHA in production to avoid local timeouts
    if (process.env.NODE_ENV === 'production' && process.env.RECAPTCHA_SECRET_KEY) {
      if (!recaptchaToken) return res.status(400).json({ error: 'Missing reCAPTCHA token' });
      const verifyBody = `secret=${encodeURIComponent(process.env.RECAPTCHA_SECRET_KEY)}&response=${encodeURIComponent(recaptchaToken)}`;

      // Apply a 5s timeout to avoid long hangs
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);
      try {
        const verifyRes = await fetch('https://www.google.com/recaptcha/api/siteverify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: verifyBody,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const verifyData = await verifyRes.json();
        if (!verifyData?.success) return res.status(400).json({ error: 'reCAPTCHA verification failed' });
      } catch (e) {
        clearTimeout(timeoutId);
        return res.status(400).json({ error: 'reCAPTCHA verification failed (timeout)' });
      }
    }

    // There may be duplicate user docs for the same email in some environments
    // and casing/whitespace differences between what the user typed and what is stored.
    // Fetch matches (try exact first, then lowercased) and deterministically
    // pick the highest-privilege, most recent doc.
    const typed = String(username || '');
    const exactSnap = await db.collection('users').where('email', '==', typed).get();
    const lower = typed.trim().toLowerCase();
    const lowerSnap = exactSnap.empty
      ? await db.collection('users').where('email', '==', lower).get()
      : { docs: [] as any[], empty: true } as any;
    const rolePriority = (r: any) => {
      const v = String(r || '').trim().toLowerCase();
      if (v === 'admin') return 4;
      if (v === 'teaching_staff') return 3;
      if (v === 'non_teaching_staff') return 2;
      if (v === 'student') return 1;
      return 0;
    };
    const allDocs = [...(exactSnap?.docs || []), ...(lowerSnap?.docs || [])];
    const seen = new Set<string>();
    const unique = allDocs.filter((d: any) => {
      const id = String(d.id);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    const docsSorted = unique
      .map((d: any) => ({ id: d.id, ...(d.data() as any) }))
      .sort((a: any, b: any) => {
        const rp = rolePriority(b.role) - rolePriority(a.role);
        if (rp !== 0) return rp;
        // Prefer most recent createdAt if available
        const taMaybe = (a.createdAt as any)?.toDate?.()?.getTime?.();
        const ta = (taMaybe ?? (new Date(a.createdAt || 0).getTime())) || 0;
        const tbMaybe = (b.createdAt as any)?.toDate?.()?.getTime?.();
        const tb = (tbMaybe ?? (new Date(b.createdAt || 0).getTime())) || 0;
        return tb - ta;
      });
    const user: any = docsSorted.length ? docsSorted[0] : null;
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    if (typeof user.password !== 'string' || !user.password) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
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

    if (user.role === 'teaching_staff' || user.role === 'non_teaching_staff') {
      await db.collection('activityLogs').add({
        type: 'Login',
        adminName: user.name || '',
        adminEmail: user.email,
        description: 'Staff logged in',
        createdAt: new Date(),
      });
    }

    const cookieBaseOptions: any = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    };
    if (process.env.COOKIE_DOMAIN) cookieBaseOptions.domain = process.env.COOKIE_DOMAIN;

    const roleLower = String(user.role || '').trim().toLowerCase();

    const token = issueJwt({ id: String(user.id), email: String(user.email), role: roleLower }, 60 * 60 * 24 * 7);

    // Proactively clear prior cookies to avoid stale tokens (different domain/path/samesite combos)
    try {
      // Clear generic path-only cookies
      res.clearCookie('auth', { path: '/' } as any);
      res.clearCookie('role', { path: '/' } as any);
      // Clear cookies using the same attributes we are about to set
      res.clearCookie('auth', cookieBaseOptions);
      res.clearCookie('role', cookieBaseOptions);
    } catch {}

    res.cookie('auth', token, {
      ...cookieBaseOptions,
      // Explicitly mark as a signed JWT cookie token
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.cookie('role', roleLower, cookieBaseOptions);

     // Fallback: also set host-only cookies (no domain) in case COOKIE_DOMAIN is misaligned
    try {
      const hostOnlyOpts: any = {
        path: '/',
        sameSite: cookieBaseOptions.sameSite,
        secure: cookieBaseOptions.secure,
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
      };
      res.cookie('auth', token, hostOnlyOpts);
      res.cookie('role', roleLower, { path: '/', sameSite: cookieBaseOptions.sameSite, secure: cookieBaseOptions.secure, httpOnly: true });
    } catch {}

    console.log('Setting cookies with options:', cookieBaseOptions);
    console.log('Auth token set:', !!token);
    console.log('Role set:', roleLower);

    return res.json({ message: 'Login successful', user: { id: user.id, email: user.email, role: roleLower, name: user.name, photo: user.photo || null } });
  } catch (e: any) {
    const message = String(e?.message || 'Login failed');
    // Hide low-level TLS/OpenSSL noise that can happen on first Mongo connect
    const isTlsNoise = /SSL routines|tlsv1 alert|openssl/i.test(message);
    return res.status( isTlsNoise ? 503 : 500 ).json({ error: isTlsNoise ? 'Database connection failed' : message });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { fullName, email, password, role } = req.body || {};
    if (!fullName || !email || !password || !role) return res.status(400).json({ error: 'All fields are required' });
    const normalizedRole = String(role).trim().toLowerCase();

    const existingSnap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!existingSnap.empty) return res.status(409).json({ error: 'Email already registered' });

    const policyErr = validatePassword(String(password));
    if (policyErr) return res.status(400).json({ error: policyErr });

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

// Magic-link pre-registration: send verification link
router.post('/register/send-link', async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // If email already exists, return generic success to avoid enumeration
    const existingSnap = await db.collection('users').where('email', '==', String(email)).limit(1).get();
    if (!existingSnap.empty) {
      return res.json({ message: 'If this email is valid, a verification link has been sent.' });
    }

    const token = createVerifyEmailToken(String(email));
    const base = (process.env.API_BASE_URL || process.env.APP_URL || 'http://localhost:4000').replace(/\/$/, '');
    const verifyUrl = `${base}/auth/register/verify?token=${encodeURIComponent(token)}`;

    try {
      const ttl = String(process.env.VERIFY_TOKEN_TTL_MIN || '15');
      const html = renderBrandedEmail({
        title: 'Verify your email',
        intro: 'Confirm your email address to continue creating your account.',
        ctaHref: verifyUrl,
        ctaText: 'Verify email',
        bodyHtml: `<p style="color:#555;font-size:14px;margin-top:0">This link expires in ${ttl} minutes.</p>`,
      });

      await sendMail({
        to: String(email),
        subject: `Verify your email`,
        html,
        text: `Verify your email to continue: ${verifyUrl} (expires in ${ttl} minutes)`,
      });
    } catch (e) {
      console.error('Failed to send verification email:', e);
      // Still return generic success to not leak existence/state
    }

    return res.json({ message: 'If this email is valid, a verification link has been sent.' });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to send verification link' });
  }
});

// Send a one-time password (OTP) to email for registration (cookie-less flow)
router.post('/register/send-otp', async (req, res) => {
  try {
    const { email } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    if (!cleanEmail) return res.status(400).json({ error: 'Email is required' });

    // Soft-enumeration protection: do not reveal if email exists
    const existingSnap = await db.collection('users').where('email', '==', cleanEmail).limit(1).get();
    if (!existingSnap.empty) {
      // Still allow sending an OTP for UX consistency, but throttle
    }

    const now = Date.now();
    const ttlMin = Number(process.env.OTP_TTL_MIN || 10);
    const resendWindowMs = 60 * 1000; // 1 minute between sends
    const maxSendsHour = Number(process.env.OTP_MAX_SENDS_PER_HOUR || 5);

    const otpsCol = db.collection('emailOtps');
    const otpDocRef = otpsCol.doc(cleanEmail);
    const otpDocSnap = await otpDocRef.get();
    const data: any = otpDocSnap.exists ? otpDocSnap.data() : null;

    const lastSentAt = Number(data?.lastSentAt || 0);
    const sendsInHour = (data?.sendsInHour && data?.windowStart && (now - Number(data.windowStart) < 60 * 60 * 1000))
      ? Number(data.sendsInHour) : 0;
    const windowStart = (data?.windowStart && (now - Number(data.windowStart) < 60 * 60 * 1000))
      ? Number(data.windowStart) : now;

    if (now - lastSentAt < resendWindowMs) {
      return res.json({ message: 'If this email is valid, an OTP has been sent.' });
    }
    if (sendsInHour >= maxSendsHour) {
      return res.json({ message: 'If this email is valid, an OTP has been sent.' });
    }

    // Generate 6-digit numeric OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    // Hash OTP to store server-side
    const hash = crypto.createHash('sha256').update(otp).digest('hex');

    await otpDocRef.set({
      email: cleanEmail,
      otpHash: hash,
      expiresAt: new Date(now + ttlMin * 60 * 1000),
      attemptCount: 0,
      lastSentAt: now,
      sendsInHour: sendsInHour + 1,
      windowStart,
      createdAt: new Date(),
      updatedAt: new Date(),
    }, { merge: true });

    try {
      const html = renderBrandedEmail({
        title: 'Your verification code',
        intro: `Use the code below to verify your email address.`,
        ctaHref: null as any,
        ctaText: '',
        bodyHtml: `<p style="font-size:24px;letter-spacing:4px;margin:16px 0"><strong>${otp}</strong></p><p style="color:#555">This code expires in ${ttlMin} minutes.</p>`,
      });
      await sendMail({
        to: cleanEmail,
        subject: 'Your verification code',
        text: `Your verification code is: ${otp}. It expires in ${ttlMin} minutes.`,
        html,
      });
    } catch (e) {
      console.error('Failed to send OTP email:', e);
      // Do not leak failure details to client
    }

    return res.json({ message: 'If this email is valid, an OTP has been sent.' });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to send OTP' });
  }
});

// Verify OTP; on success, return short-lived registration token in body
router.post('/register/verify-otp', async (req, res) => {
  try {
    const { email, otp } = req.body || {};
    const cleanEmail = String(email || '').trim().toLowerCase();
    const provided = String(otp || '').trim();
    if (!cleanEmail || !provided) return res.status(400).json({ error: 'Email and OTP are required' });

    const otpDocRef = db.collection('emailOtps').doc(cleanEmail);
    const snap = await otpDocRef.get();
    if (!snap.exists) return res.status(400).json({ error: 'Invalid or expired code' });
    const data = snap.data() as any;
    const expiresAt = data?.expiresAt?.toDate?.() || data?.expiresAt;
    if (!expiresAt || new Date(expiresAt).getTime() < Date.now()) {
      return res.status(400).json({ error: 'Invalid or expired code' });
    }
    const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS || 5);
    const attemptCount = Number(data?.attemptCount || 0);
    if (attemptCount >= maxAttempts) {
      return res.status(400).json({ error: 'Too many attempts. Please request a new code.' });
    }

    const expectedHash = String(data?.otpHash || '');
    const providedHash = crypto.createHash('sha256').update(provided).digest('hex');
    const ok = expectedHash && providedHash === expectedHash;

    if (!ok) {
      await otpDocRef.set({ attemptCount: attemptCount + 1, updatedAt: new Date() }, { merge: true });
      return res.status(400).json({ error: 'Invalid code' });
    }

    // Success → issue the same style short-lived registration token
    const token = createRegistrationToken(cleanEmail);

    // Invalidate OTP after successful verification
    try { await otpDocRef.delete(); } catch {}

    const ttlMin = Number(process.env.REG_TOKEN_TTL_MIN || 15);
    return res.json({ registrationToken: token, expiresInMinutes: ttlMin });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'Failed to verify code' });
  }
});

// Magic-link verify endpoint: exchanges email token for short-lived registration token cookie
router.get('/register/verify', async (req, res) => {
  try {
    const token = String(req.query.token || '');
    if (!token) return res.status(400).send('Missing token');
    const payload = verifyVerifyEmailToken(token);
    if (payload.purpose !== 'register-verify') return res.status(400).send('Invalid token');

    const regToken = createRegistrationToken(payload.email);
    const cookieBaseOptions: any = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: (Number(process.env.REG_TOKEN_TTL_MIN || 15)) * 60 * 1000,
    };
    if (process.env.COOKIE_DOMAIN) cookieBaseOptions.domain = process.env.COOKIE_DOMAIN;

    res.cookie('registrationToken', regToken, cookieBaseOptions);

    const frontend = (process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
    return res.redirect(`${frontend}/register/complete`);
  } catch (e: any) {
    return res.status(400).send('Invalid or expired token');
  }
});

// Complete registration using short-lived registration token
router.post('/register/complete', async (req, res) => {
  try {
    const token = (req.cookies && req.cookies.registrationToken) || String(req.body?.registrationToken || '');
    const { name, password, role } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing registration token' });
    if (!name || !password || !role) return res.status(400).json({ error: 'All fields are required' });

    const payload = verifyRegistrationToken(token);
    if (payload.purpose !== 'register-complete') return res.status(400).json({ error: 'Invalid token' });
    const email = String(payload.email || '');

    // Ensure not already registered (acts as uniqueness guard)
    const existingSnap = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!existingSnap.empty) return res.status(409).json({ error: 'Email already registered' });

    const normalizedRole = String(role).trim().toLowerCase();
    const policyErr = validatePassword(String(password));
    if (policyErr) return res.status(400).json({ error: policyErr });
    const hashed = await bcrypt.hash(String(password), 10);
    await db.collection('users').add({
      name: String(name),
      email,
      password: hashed,
      role: normalizedRole,
      createdAt: new Date(),
      emailVerified: true,
    });

    // Send welcome/confirmation email
    try {
      const frontendBase = (process.env.FRONTEND_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
      const loginUrl = `${frontendBase}/`;
      const html = renderBrandedEmail({
        title: 'Registration complete',
        intro: `Welcome to ${process.env.APP_NAME || 'SPARTA'}! Your email has been verified and your account is ready.`,
        ctaHref: loginUrl,
        ctaText: 'Log in',
      });
      await sendMail({
        to: email,
        subject: 'Welcome! Your registration is complete',
        html,
        text: `Your account is ready. Log in: ${loginUrl}`,
      });
    } catch (e) {
      console.error('Failed to send registration confirmation email:', e);
    }

    // Clear the short-lived token cookie
    const cookieBaseOptions: any = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'lax' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    };
    if (process.env.COOKIE_DOMAIN) cookieBaseOptions.domain = process.env.COOKIE_DOMAIN;
    res.clearCookie('registrationToken', cookieBaseOptions);

    return res.json({ message: 'Registration successful' });
  } catch (e: any) {
    return res.status(400).json({ error: e?.message || 'Failed to complete registration' });
  }
});

// Logout route
router.post('/logout', (req, res) => {
  try {
    // Clear the authentication cookies with the same options used to set them
    const cookieBaseOptions: any = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    };
    if (process.env.COOKIE_DOMAIN) cookieBaseOptions.domain = process.env.COOKIE_DOMAIN;

    res.clearCookie('auth', cookieBaseOptions);
    res.clearCookie('role', cookieBaseOptions);

    console.log('Logout: Cookies cleared with options:', cookieBaseOptions);
    return res.json({ message: 'Logout successful' });
  } catch (e: any) {
    console.log('Logout error:', e);
    return res.status(500).json({ error: e?.message || 'Logout failed' });
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

    try {
      const html = renderBrandedEmail({
        title: 'Reset your password',
        intro: 'Click the button below to create a new password.',
        ctaHref: resetLink,
        ctaText: 'Reset password',
      });
      await sendMail({
        to: user.email,
        subject: 'Password Reset',
        text: `Reset your password: ${resetLink}`,
        html,
      });
    } catch (e) {
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
    const policyErr = validatePassword(String(password));
    if (policyErr) return res.status(400).json({ error: policyErr });
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

// Logout - clear cookies
router.post('/logout', async (_req, res) => {
  const cookieBaseOptions: any = {
    httpOnly: true,
    sameSite: (process.env.COOKIE_SAMESITE as any) || 'lax',
    secure: process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production',
    path: '/',
  };
  if (process.env.COOKIE_DOMAIN) cookieBaseOptions.domain = process.env.COOKIE_DOMAIN;

  res.clearCookie('auth', cookieBaseOptions);
  res.clearCookie('role', cookieBaseOptions);
  return res.json({ ok: true });
});

// Verify current session and return the decoded user
router.get('/me', requireAuth, async (req, res) => {
  return res.json({ user: req.user });
});


// Profile: update name (and optionally photo) without OTP - MongoDB
router.post('/profile/update-name', requireAuth, async (req, res) => {
  try {
    const { name, photo } = req.body || {};
    const cleanName = String(name || '').trim();
    if (!cleanName) return res.status(400).json({ success: false, error: 'Name is required' });

    const dbm = await getMongoDb();
    const usersCol = dbm.collection('users');
    const email = String((req as any)?.user?.email || '').trim().toLowerCase();
    if (!email) return res.status(401).json({ success: false, error: 'Unauthorized' });

    const set: any = { name: cleanName, updatedAt: new Date() };
    if (typeof photo === 'string') set.photo = photo;
    await usersCol.updateOne({ email }, { $set: set });

    // Also update leaderboard display name if present (best-effort)
    try {
      const userDoc = await usersCol.findOne({ email }, { projection: { _id: 1 } });
      if (userDoc?._id) {
        await dbm.collection('leaderboard').updateMany({ userId: String(userDoc._id) }, { $set: { name: cleanName, updatedAt: new Date() } });
      }
    } catch {}

    return res.json({ success: true });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Failed to update name' });
  }
});

// Profile: send OTP to verify new email - MongoDB
router.post('/profile/send-email-otp', requireAuth, async (req, res) => {
  try {
    const { newEmail } = req.body || {};
    const cleanNew = String(newEmail || '').trim().toLowerCase();
    if (!cleanNew) return res.status(400).json({ success: false, error: 'New email is required' });

    const dbm = await getMongoDb();
    const usersCol = dbm.collection('users');

    // Ensure email not already in use
    const existing = await usersCol.findOne({ email: cleanNew });
    if (existing) return res.status(409).json({ success: false, error: 'Email already in use' });

    // Throttle/issue OTP
    const now = Date.now();
    const ttl = Number(process.env.OTP_TTL_MIN || 10);
    const resendWindowMs = 60 * 1000;
    const emailOtps = dbm.collection('emailOtps');

    const userEmail = String((req as any)?.user?.email || '').trim().toLowerCase();
    const key = { purpose: 'change-email', userEmail, newEmail: cleanNew };
    const doc = await emailOtps.findOne(key);

    if (doc && typeof doc.lastSentAt === 'number' && now - doc.lastSentAt < resendWindowMs) {
      // Soft success to avoid enumeration UX
      return res.json({ success: true, message: 'OTP sent if eligible' });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const hash = crypto.createHash('sha256').update(otp).digest('hex');
    await emailOtps.updateOne(
      key,
      {
        $set: {
          otpHash: hash,
          lastSentAt: now,
          attemptCount: 0,
          expiresAt: new Date(now + ttl * 60 * 1000),
          createdAt: doc?.createdAt || new Date(),
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );

    try {
      const html = renderBrandedEmail({
        title: 'Verify your new email',
        intro: 'Use the code below to confirm your new email address.',
        ctaHref: null as any,
        ctaText: '',
        bodyHtml: `<p style="font-size:24px;letter-spacing:4px;margin:16px 0"><strong>${otp}</strong></p><p style="color:#555">This code expires in ${ttl} minutes.</p>`,
      });
      await sendMail({
        to: cleanNew,
        subject: 'Your verification code',
        text: `Your verification code is: ${otp}. It expires in ${ttl} minutes.`,
        html,
      });
    } catch {}

    return res.json({ success: true, message: 'OTP sent if eligible' });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Failed to send OTP' });
  }
});

// Profile: verify OTP and change email - MongoDB
router.post('/profile/verify-email-otp', requireAuth, async (req, res) => {
  try {
    const { newEmail, otp } = req.body || {};
    const cleanNew = String(newEmail || '').trim().toLowerCase();
    const provided = String(otp || '').trim();
    if (!cleanNew || !provided) return res.status(400).json({ success: false, error: 'Email and OTP are required' });

    const dbm = await getMongoDb();
    const usersCol = dbm.collection('users');
    const emailOtps = dbm.collection('emailOtps');

    const userEmail = String((req as any)?.user?.email || '').trim().toLowerCase();
    const key = { purpose: 'change-email', userEmail, newEmail: cleanNew };
    const doc = await emailOtps.findOne(key);
    if (!doc) return res.status(400).json({ success: false, error: 'Invalid or expired code' });

    const expiresAt = doc?.expiresAt instanceof Date ? doc.expiresAt : new Date(doc?.expiresAt || 0);
    if (!expiresAt || expiresAt.getTime() < Date.now()) {
      return res.status(400).json({ success: false, error: 'Invalid or expired code' });
    }
    const attemptCount = Number(doc?.attemptCount || 0);
    const maxAttempts = Number(process.env.OTP_MAX_ATTEMPTS || 5);
    if (attemptCount >= maxAttempts) {
      return res.status(400).json({ success: false, error: 'Too many attempts. Please request a new code.' });
    }

    const expected = String(doc?.otpHash || '');
    const providedHash = crypto.createHash('sha256').update(provided).digest('hex');
    if (!expected || expected !== providedHash) {
      await emailOtps.updateOne(key, { $set: { attemptCount: attemptCount + 1, updatedAt: new Date() } });
      return res.status(400).json({ success: false, error: 'Invalid code' });
    }

    // Passed → change email
    const userDoc = await usersCol.findOne({ email: userEmail });
    if (!userDoc) return res.status(404).json({ success: false, error: 'User not found' });

    await usersCol.updateOne({ _id: userDoc._id }, { $set: { email: cleanNew, updatedAt: new Date() } });
    try { await emailOtps.deleteOne(key); } catch {}

    // Issue new JWT cookie with updated email
    const cookieBaseOptions: any = {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
    };
    if (process.env.COOKIE_DOMAIN) cookieBaseOptions.domain = process.env.COOKIE_DOMAIN;
    const roleLower = String(userDoc.role || '').trim().toLowerCase();
    const token = issueJwt({ id: String(userDoc._id), email: cleanNew, role: roleLower }, 60 * 60 * 24 * 7);

    try {
      res.clearCookie('auth', { path: '/' } as any);
      res.clearCookie('role', { path: '/' } as any);
      res.clearCookie('auth', cookieBaseOptions);
      res.clearCookie('role', cookieBaseOptions);
    } catch {}
    res.cookie('auth', token, { ...cookieBaseOptions, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.cookie('role', roleLower, cookieBaseOptions);

    return res.json({ success: true, user: { id: String(userDoc._id), email: cleanNew, name: userDoc.name, role: roleLower, photo: userDoc.photo || null } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Failed to verify code' });
  }
});

