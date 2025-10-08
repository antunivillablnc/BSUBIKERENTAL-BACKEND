import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import authRouter from './routes/auth';
import applicationRouter from './routes/application';
import bikesRouter from './routes/bikes';
import dashboardRouter from './routes/dashboard';
import leaderboardRouter from './routes/leaderboard';
import myBikeRouter from './routes/myBike';
import adminSplitRouter from './routes/admin/index';
import uploadRouter from './routes/upload';
import reportedIssuesRouter from './routes/reportedIssues';

const app = express();

const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const allowAll = allowedOrigins.includes('*');

app.use(
  cors({
    origin: allowAll
      ? true
      : (origin, callback) => {
          if (!origin) return callback(null, true);
          callback(null, allowedOrigins.includes(origin));
        },
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/auth', authRouter);
app.use('/applications', applicationRouter);
app.use('/bikes', bikesRouter);
app.use('/dashboard', dashboardRouter);
app.use('/leaderboard', leaderboardRouter);
app.use('/my-bike', myBikeRouter);
import { requireRole } from './middleware/auth';
app.use('/admin', requireRole('admin', 'teaching_staff'), adminSplitRouter);
app.use('/upload-profile-photo', uploadRouter);
app.use('/reported-issues', reportedIssuesRouter);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}`);
});


