import { MongoClient, Db, ObjectId } from 'mongodb';

let cachedClient: MongoClient | null = null;
let cachedDb: Db | null = null;

export async function getMongoClient(): Promise<MongoClient> {
  if (cachedClient) return cachedClient;
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is not set');
  // Add conservative timeouts so API calls fail fast instead of hanging
  const client = new MongoClient(uri, {
    // Fail server selection quickly if cluster/whitelist is misconfigured
    serverSelectionTimeoutMS: Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 5000),
    // Initial TCP connect timeout
    connectTimeoutMS: Number(process.env.MONGO_CONNECT_TIMEOUT_MS || 5000),
    // Socket inactivity timeout
    socketTimeoutMS: Number(process.env.MONGO_SOCKET_TIMEOUT_MS || 15000),
  } as any);
  await client.connect();
  cachedClient = client;
  return client;
}

export async function getMongoDb(): Promise<Db> {
  if (cachedDb) return cachedDb;
  const client = await getMongoClient();
  const uri = process.env.MONGODB_URI || '';
  const envName = process.env.MONGODB_DB;
  // Try to derive DB name from URI if not explicitly provided
  const uriNameMatch = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
  const derivedName = uriNameMatch && uriNameMatch[1] ? decodeURIComponent(uriNameMatch[1]) : undefined;
  const dbName = envName || derivedName || 'bikerental';
  cachedDb = client.db(dbName);
  try {
    await cachedDb.command({ ping: 1 });
    // Safe connect log without credentials
    console.log(`[mongo] connected to database: ${dbName}`);
  } catch {}
  return cachedDb;
}

export function toObjectId(id: string): ObjectId {
  try {
    return new ObjectId(id);
  } catch {
    // Fallback to a deterministic ObjectId from string hash if invalid format
    // but still throw to surface issues early
    throw new Error(`Invalid ObjectId: ${id}`);
  }
}

export function maybeObjectId(id: string): any {
  try {
    return new ObjectId(id);
  } catch {
    return id;
  }
}


