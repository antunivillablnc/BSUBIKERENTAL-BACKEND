import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { db } from '../lib/firebase.js';

export type JwtUserPayload = {
  id: string;
  email: string;
  role: string;
};

const getJwtSecret = (): string => {
  // In development, allow a safe default to avoid 500s if env is missing
  const fromEnv = process.env.JWT_SECRET;
  const fallback = process.env.NODE_ENV !== 'production' ? 'dev-secret-change-me' : '';
  const secret = fromEnv || fallback;
  if (!secret) {
    throw new Error('JWT_SECRET is not set');
  }
  return secret;
};

export function issueJwt(payload: JwtUserPayload, expiresInSeconds: number = 60 * 60 * 24 * 7): string {
  return jwt.sign(payload, getJwtSecret(), { expiresIn: expiresInSeconds });
}

export function verifyJwtToken(token: string): JwtUserPayload {
  return jwt.verify(token, getJwtSecret()) as JwtUserPayload;
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    console.log('Auth middleware - cookies:', req.cookies);
    console.log('Auth middleware - headers:', req.headers);
    
    const token = (req.cookies && req.cookies.auth) || extractBearerToken(req);
    console.log('Auth middleware - token found:', !!token);
    
    if (!token) {
      console.log('Auth middleware - no token found');
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const decoded = verifyJwtToken(token);
    console.log('Auth middleware - decoded user:', decoded);
    
    // Attach minimal user info to request
    req.user = decoded;
    return next();
  } catch (error) {
    console.log('Auth middleware - error:', error);
    return res.status(401).json({ error: 'Unauthorized' });
  }
}

export function requireRole(...allowedRoles: string[]) {
  const allowed = new Set(allowedRoles.map(r => String(r).toLowerCase()));
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const token = (req.cookies && req.cookies.auth) || extractBearerToken(req);
      if (!token) return res.status(401).json({ error: 'Unauthorized' });
      const decoded = verifyJwtToken(token);
      const roleLower = String(decoded.role || '').toLowerCase().trim();

      if (!allowed.has(roleLower)) {
        // Fallback: trust the current role in the database if it is more privileged.
        try {
          const email = String((decoded as any).email || '').trim().toLowerCase();
          if (email) {
            const snap = await db.collection('users').where('email', '==', email).limit(1).get();
            const doc = (snap as any)?.docs?.[0];
            const data: any = doc ? doc.data() : undefined;
            const dbRole = String(data?.role || '').trim().toLowerCase();
            if (dbRole && allowed.has(dbRole)) {
              // Upgrade role for this request based on authoritative DB
              (decoded as any).role = dbRole;
              req.user = decoded;
              return next();
            }
          }
        } catch (e) {
          // Ignore fallback errors; proceed to deny
        }
        return res.status(403).json({ error: 'Forbidden' });
      }
      req.user = decoded;
      return next();
    } catch {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  };
}

function extractBearerToken(req: Request): string | undefined {
  const header = req.get('Authorization');
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token;
}


