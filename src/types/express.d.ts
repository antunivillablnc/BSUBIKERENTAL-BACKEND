import type { JwtUserPayload } from '../middleware/auth.js';

declare global {
  namespace Express {
    interface Request {
      user?: JwtUserPayload;
    }
  }
}

export {};


