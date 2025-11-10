import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import authRouter from './routes/auth.js';
import applicationRouter from './routes/application.js';
import bikesRouter from './routes/bikes.js';
import dashboardRouter from './routes/dashboard.js';
import leaderboardRouter from './routes/leaderboard.js';
import adminSplitRouter from './routes/admin/index.js';
import uploadRouter from './routes/upload.js';
import uploadIssueRouter from './routes/uploadIssue.js';
import notificationsRouter from './routes/notifications.js';
import reportedIssuesRouter from './routes/reportedIssues.js';
import maintenanceRouter from './routes/maintenance.js';
import resendWebhookRouter from './routes/webhooks/resend.js';
import trackerRouter from './routes/tracker.js';

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
      : (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
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
import { requireRole } from './middleware/auth.js';
app.use('/admin', requireRole('admin', 'teaching_staff', 'non_teaching_staff'), adminSplitRouter);
app.use('/upload-profile-photo', uploadRouter);
app.use('/upload-issue', uploadIssueRouter);
app.use('/notifications', notificationsRouter);
app.use('/reported-issues', reportedIssuesRouter);
app.use('/maintenance', requireRole('admin', 'teaching_staff'), maintenanceRouter);
app.use('/webhooks/resend', resendWebhookRouter);
app.use('/tracker', trackerRouter);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`[backend] listening on http://localhost:${port}`);
});

console.log('[tracker] secret present:', !!process.env.IOT_SHARED_SECRET, 'len:', (process.env.IOT_SHARED_SECRET || '').length);

