import jwt from 'jsonwebtoken';

function getRegTokenSecret(): string {
  const fromEnv = process.env.REG_TOKEN_SECRET;
  const fallback = process.env.NODE_ENV !== 'production' ? 'dev-reg-secret-change-me' : '';
  const secret = fromEnv || fallback;
  if (!secret) throw new Error('REG_TOKEN_SECRET is not set');
  return secret;
}

export function createVerifyEmailToken(email: string, ttlMinutes: number = Number(process.env.VERIFY_TOKEN_TTL_MIN || 15)) {
  return jwt.sign({ email, purpose: 'register-verify' }, getRegTokenSecret(), { expiresIn: `${ttlMinutes}m` });
}

export function verifyVerifyEmailToken(token: string): { email: string; purpose: string; iat: number; exp: number } {
  return jwt.verify(token, getRegTokenSecret()) as any;
}

export function createRegistrationToken(email: string, ttlMinutes: number = Number(process.env.REG_TOKEN_TTL_MIN || 15)) {
  return jwt.sign({ email, purpose: 'register-complete' }, getRegTokenSecret(), { expiresIn: `${ttlMinutes}m` });
}

export function verifyRegistrationToken(token: string): { email: string; purpose: string; iat: number; exp: number } {
  return jwt.verify(token, getRegTokenSecret()) as any;
}


