import 'dotenv/config';
import { db } from '../lib/firebase';

async function seedReportedIssues() {
  const existing = await db.collection('reported_issues').limit(1).get();
  if (!existing.empty) {
    console.log('reported_issues already has data, skipping.');
    return;
  }

  await db.collection('reported_issues').add({
    subject: 'Brake issue',
    message: 'Rear brake squeaks when stopping',
    category: 'bike_damage',
    priority: 'medium',
    status: 'open',
    imageUrl: null,
    reportedBy: 'user@example.com',
    reportedAt: new Date(),
    assignedTo: null,
    resolvedAt: null,
    adminNotes: '',
  });
  console.log('Seeded reported_issues with one item.');
}

seedReportedIssues().catch(err => {
  console.error(err);
  process.exitCode = 1;
});


