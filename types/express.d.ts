import 'express';
import type { JwtUserPayload } from '../src/middleware/auth';

declare module 'express-serve-static-core' {
  interface Request {
    user?: JwtUserPayload;
  }
}


