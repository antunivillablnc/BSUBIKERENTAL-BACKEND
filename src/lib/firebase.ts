import { applicationDefault, cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getDatabase } from 'firebase-admin/database';
import { getMongoDb, maybeObjectId } from './mongo.js';
import fs from 'node:fs';

const apps = getApps();
let projectId = process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCP_PROJECT;
const USE_MONGO = (process.env.DATA_STORE || '').toLowerCase() === 'mongo';

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

export const firebaseApp = USE_MONGO
  ? (undefined as any)
  : (apps.length
      ? apps[0]
      : initializeApp({
          credential: buildCredential(),
          ...(projectId ? { projectId } : {}),
          ...(process.env.FIREBASE_DATABASE_URL ? { databaseURL: process.env.FIREBASE_DATABASE_URL } : {}),
        }));

// --- Minimal Firestore-compat wrapper backed by MongoDB ---
type OrderDir = 'asc' | 'desc' | undefined;

function isObjectIdHex(id: string) {
  return /^[a-fA-F0-9]{24}$/.test(id);
}

// ObjectId conversion is done lazily via dynamic import where needed

class CompatDocSnapshot {
  constructor(public id: string, private _data: any, public exists: boolean) {}
  data() { return this._data; }
}

class CompatQuerySnapshot {
  public empty: boolean;
  public size: number;
  constructor(public docs: CompatDocSnapshot[]) {
    this.size = docs.length;
    this.empty = this.size === 0;
  }
}

class CompatDocumentRef {
  constructor(private collectionName: string, private id: string) {}

  private async col() { return (await getMongoDb()).collection(this.collectionName); }

  async get() {
    const col = await this.col();
    const key = isObjectIdHex(this.id) ? maybeObjectId(this.id) : this.id;
    const doc = await col.findOne({ _id: key });
    if (!doc) return new CompatDocSnapshot(this.id, undefined, false);
    const { _id, ...rest } = doc as any;
    return new CompatDocSnapshot(String(_id), rest, true);
  }

  async set(data: any, opts?: { merge?: boolean }) {
    const col = await this.col();
    const key = isObjectIdHex(this.id) ? maybeObjectId(this.id) : this.id;
    if (opts?.merge) {
      await col.updateOne({ _id: key }, { $set: data }, { upsert: true });
    } else {
      await col.replaceOne({ _id: key }, { ...data, _id: key }, { upsert: true });
    }
  }

  async update(patch: Record<string, any>) {
    const col = await this.col();
    const key = isObjectIdHex(this.id) ? maybeObjectId(this.id) : this.id;
    await col.updateOne({ _id: key }, { $set: patch });
  }

  async delete() {
    const col = await this.col();
    const key = isObjectIdHex(this.id) ? maybeObjectId(this.id) : this.id;
    await col.deleteOne({ _id: key });
  }
}

class CompatQueryRef {
  private _filter: Record<string, any> = {};
  private _sort: Record<string, 1 | -1> = {};
  private _limit = 0;

  constructor(private collectionName: string) {}

  private async col() { return (await getMongoDb()).collection(this.collectionName); }

  where(field: string, op: any, value: any) {
    if (op === '==') this._filter[field] = value;
    else if (op === '>') this._filter[field] = { ...(this._filter[field] || {}), $gt: value };
    else if (op === ">=") this._filter[field] = { ...(this._filter[field] || {}), $gte: value };
    else if (op === '<') this._filter[field] = { ...(this._filter[field] || {}), $lt: value };
    else if (op === '<=') this._filter[field] = { ...(this._filter[field] || {}), $lte: value };
    return this;
  }

  orderBy(field: string, dir?: OrderDir) {
    this._sort[field] = dir === 'desc' ? -1 : 1;
    return this;
  }

  limit(n: number) { this._limit = n; return this; }

  async get() {
    const col = await this.col();
    let cursor = col.find(this._filter);
    if (Object.keys(this._sort).length) cursor = cursor.sort(this._sort);
    if (this._limit > 0) cursor = cursor.limit(this._limit);
    const docs = await cursor.toArray();
    const mapped = docs.map((d: any) => {
      const { _id, ...rest } = d;
      return new CompatDocSnapshot(String(_id), rest, true);
    });
    return new CompatQuerySnapshot(mapped);
  }

  onSnapshot(cb: (snap: CompatQuerySnapshot) => void) {
    const run = async () => {
      try { cb(await this.get()); } catch {}
    };
    const id = setInterval(run, 3000);
    run();
    return () => clearInterval(id);
  }
}

class CompatCollectionRef extends CompatQueryRef {
  constructor(private _name: string) { super(_name); }

  doc(id: string) { return new CompatDocumentRef(this._name, id); }

  async add(data: any) {
    const col = (await getMongoDb()).collection(this._name);
    const res = await col.insertOne({ ...data });
    return { id: String(res.insertedId) } as any;
  }
}

class CompatWriteBatch {
  private ops: any[] = [];
  constructor() {}

  set(ref: any, data: any, opts?: { merge?: boolean }) {
    const collection = ref.collectionName || ref._name;
    const id = ref.id;
    if (opts?.merge) {
      this.ops.push({ collection, op: 'updateOne', id, update: { $set: data }, upsert: true });
    } else {
      this.ops.push({ collection, op: 'replaceOne', id, replacement: { ...data }, upsert: true });
    }
  }

  update(ref: any, patch: Record<string, any>) {
    const collection = ref.collectionName || ref._name;
    const id = ref.id;
    this.ops.push({ collection, op: 'updateOne', id, update: { $set: patch } });
  }

  async commit() {
    const db = await getMongoDb();
    const grouped: Record<string, any[]> = {};
    for (const op of this.ops) {
      grouped[op.collection] = grouped[op.collection] || [];
      const key = isObjectIdHex(op.id) ? maybeObjectId(op.id) : op.id;
      if (op.op === 'updateOne') grouped[op.collection].push({ updateOne: { filter: { _id: key }, update: op.update, upsert: op.upsert } });
      else if (op.op === 'replaceOne') grouped[op.collection].push({ replaceOne: { filter: { _id: key }, replacement: { ...op.replacement, _id: key }, upsert: op.upsert } });
    }
    for (const [name, ops] of Object.entries(grouped)) {
      if (ops.length) await db.collection(name).bulkWrite(ops);
    }
  }
}

class MongoFirestoreCompatDb {
  collection(name: string) {
    const ref: any = new CompatCollectionRef(name);
    (ref as any).collectionName = name; // for batch helpers
    return ref;
  }
  batch() { return new CompatWriteBatch(); }
}

export const db: any = USE_MONGO ? new MongoFirestoreCompatDb() : getFirestore(firebaseApp);
if (USE_MONGO) {
  console.log('[db] Using Mongo Firestore-compat layer');
}

// Optional Realtime Database instance (URL can be omitted if default).
// Always attempt to use the real Firebase Admin RTDB even when DATA_STORE=mongo,
// so we can keep IoT data in RTDB while app data lives in Mongo.
export const rtdb = (() => {
  try {
    const appsNow = getApps();
    const appForRtdb =
      appsNow.length
        ? appsNow[0]
        : initializeApp({
            credential: buildCredential(),
            ...(projectId ? { projectId } : {}),
            ...(process.env.FIREBASE_DATABASE_URL ? { databaseURL: process.env.FIREBASE_DATABASE_URL } : {}),
          });
    const db = getDatabase(appForRtdb);
    try {
      const canUpdate = typeof (db as any).ref === 'function' && typeof (db as any).ref('/').update === 'function';
      console.log('[rtdb] initialized:', canUpdate ? 'admin' : 'limited');
    } catch {}
    return db;
  } catch {
    // Minimal shim to avoid crashes if credentials are missing in local dev
    return ({ ref: (_path: string = '/') => ({ set: async (_value: any) => {}, update: async (_: any) => {} }) } as any);
  }
})();


