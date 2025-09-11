import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'node:fs';

const apps = getApps();
let projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;

// Fallback: derive projectId from ADC JSON if available
if (!projectId && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  try {
    const raw = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && parsed.project_id) projectId = parsed.project_id as string;
  } catch {
    // ignore
  }
}

function buildCredential() {
  // 1) JSON blob or base64-encoded JSON in FIREBASE_CREDENTIALS_JSON
  const json = process.env.FIREBASE_CREDENTIALS_JSON;
  if (json) {
    try {
      const decoded = json.trim().startsWith('{') ? json : Buffer.from(json, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (!projectId && parsed.project_id) projectId = parsed.project_id as string;
      return cert({
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
      });
    } catch {
      // fallthrough
    }
  }
  // 2) Explicit env triple
  if (process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PROJECT_ID) {
    return cert({
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY!.replace(/\\n/g, '\n'),
    });
  }
  // 3) GOOGLE_APPLICATION_CREDENTIALS path → read JSON
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    try {
      const raw = fs.readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8');
      const parsed = JSON.parse(raw);
      if (!projectId && parsed.project_id) projectId = parsed.project_id as string;
      return cert({
        projectId: parsed.project_id,
        clientEmail: parsed.client_email,
        privateKey: parsed.private_key,
      });
    } catch {
      // fallthrough
    }
  }
  // 4) Fall back to ADC
  return applicationDefault();
}

export const firebaseApp = apps.length
  ? apps[0]
  : initializeApp({
      credential: buildCredential(),
      ...(projectId ? { projectId } : {}),
    });

export const db = getFirestore(firebaseApp);


