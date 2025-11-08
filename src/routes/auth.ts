import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { sendMail, renderBrandedEmail } from '../lib/mailer.js';
import { createRegistrationToken, createVerifyEmailToken, verifyRegistrationToken, verifyVerifyEmailToken } from '../lib/tokens.js';
import crypto from 'node:crypto';
import { db } from '../lib/firebase.js';
import { validatePassword } from '../lib/password.js';
import { issueJwt, requireAuth } from '../middleware/auth.js';

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

    const userSnap = await db.collection('users').where('email', '==', username).limit(1).get();
    const userDoc = userSnap.docs[0];
    const user: any = userDoc ? { id: userDoc.id, ...userDoc.data() } : null;
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

    const roleLower = String(user.role || '').toLowerCase();

    const token = issueJwt({ id: String(user.id), email: String(user.email), role: roleLower }, 60 * 60 * 24 * 7);
    res.cookie('auth', token, {
      ...cookieBaseOptions,
      // Explicitly mark as a signed JWT cookie token
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.cookie('role', roleLower, cookieBaseOptions);

    console.log('Setting cookies with options:', cookieBaseOptions);
    console.log('Auth token set:', !!token);
    console.log('Role set:', roleLower);

    return res.json({ message: 'Login successful', user: { id: user.id, email: user.email, role: roleLower, name: user.name } });
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
    const normalizedRole = String(role).toLowerCase();

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

    const normalizedRole = String(role).toLowerCase();
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


