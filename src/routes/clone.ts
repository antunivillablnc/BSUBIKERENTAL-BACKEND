import { Router } from 'express';
import { rtdb } from '../lib/firebase.js';

const router = Router();

const DEFAULT_SOURCE = '/GPS Tracking';
const DEFAULT_TARGET = '/GPS TRACKING HISTORY';

// Convert NMEA-style ddmm.mmmm (or dddmm.mmmm for longitude) to decimal degrees.
function fromNmeaDdmm(value: number, kind: 'lat' | 'lng'): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const abs = Math.abs(value);
  // Heuristic: values below 100 are unlikely to be ddmm.mmmm
  if (abs < 100) return undefined;
  const degrees = Math.floor(abs / 100);
  const minutes = abs - degrees * 100;
  const decimal = degrees + minutes / 60;
  const signed = value < 0 ? -decimal : decimal;
  if (kind === 'lat') {
    if (decimal > 90) return undefined;
  } else {
    if (decimal > 180) return undefined;
  }
  return signed;
}

// Normalize a legacy bike ID (like "001") into "BIKE_TRACKER_001".
function toBikeTrackerId(rawId: string): string {
  const match = String(rawId).match(/\d+/);
  if (match) {
    const n = Number.parseInt(match[0], 10);
    if (Number.isFinite(n)) {
      return `BIKE_TRACKER_${n.toString().padStart(3, '0')}`;
    }
  }
  // Fallback: sanitize and suffix
  const safe = String(rawId).replace(/[^\w]+/g, '_');
  return `BIKE_TRACKER_${safe || 'UNKNOWN'}`;
}

// Append telemetry points into the GPS TRACKING HISTORY tree using
// the structure:
//   /GPS TRACKING HISTORY/devices/BIKE_TRACKER_XXX/telemetry/<timestamp>
async function appendHistorySnapshot(data: any) {
  const db: any = rtdb as any;
  if (!db || typeof db.ref !== 'function') throw new Error('rtdb unavailable');

  if (!data || typeof data !== 'object') return;

  // Many legacy dumps are shaped like { Bikes: { "001": "{...json...}", ... } }
  const bikesRoot: any =
    (data as any).Bikes && typeof (data as any).Bikes === 'object'
      ? (data as any).Bikes
      : data;

  const entries = Object.entries(bikesRoot || {});
  if (!entries.length) return;

  const ops: Promise<any>[] = [];

  for (const [rawId, rawValue] of entries) {
    let payload: any = null;
    if (typeof rawValue === 'string') {
      try {
        payload = JSON.parse(rawValue);
      } catch {
        continue;
      }
    } else if (rawValue && typeof rawValue === 'object') {
      payload = rawValue;
    } else {
      continue;
    }

    let lat = Number(
      (payload as any).Lat ??
      (payload as any).lat ??
      (payload as any).latitude
    );
    let lng = Number(
      (payload as any).Long ??
      (payload as any).long ??
      (payload as any).lng ??
      (payload as any).longitude
    );
    const speedRaw =
      (payload as any).Speed ??
      (payload as any).speed ??
      (payload as any).kmh;
    const speed = speedRaw !== undefined && speedRaw !== null ? Number(speedRaw) : null;

    let tsRaw =
      (payload as any).Timestamp ??
      (payload as any).timestamp ??
      (payload as any).ts ??
      (payload as any).time;

    let tsNum =
      typeof tsRaw === 'number'
        ? tsRaw
        : tsRaw !== undefined && tsRaw !== null
        ? Number(tsRaw)
        : NaN;

    // Attempt to convert NMEA ddmm.mmmm / dddmm.mmmm if raw numeric is out of range
    const limitLat = 90;
    const limitLng = 180;
    if (Number.isFinite(lat) && Math.abs(lat) > limitLat) {
      const converted = fromNmeaDdmm(lat, 'lat');
      if (converted !== undefined) lat = converted;
    }
    if (Number.isFinite(lng) && Math.abs(lng) > limitLng) {
      const converted = fromNmeaDdmm(lng, 'lng');
      if (converted !== undefined) lng = converted;
    }

    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(tsNum)) {
      continue;
    }

    // Normalize timestamps: treat values < 2e12 as seconds and convert to ms
    if (tsNum < 2_000_000_000) {
      tsNum *= 1000;
    }

    const bikeId = toBikeTrackerId(rawId);
    const tsKey = String(tsNum);

    const telemetry = {
      lat,
      lng,
      speed,
      ts: tsNum,
    };

    const path = `${DEFAULT_TARGET}/devices/${bikeId}/telemetry/${tsKey}`;
    const ref = db.ref(path);
    if (ref && typeof ref.set === 'function') {
      ops.push(ref.set(telemetry));
    }
  }

  if (ops.length) {
    await Promise.all(ops);
  }
}

// Start a background listener that continuously mirrors the
// latest data from `/GPS Tracking` → `/GPS TRACKING HISTORY`.
function startContinuousMirror() {
  try {
    const db: any = rtdb as any;
    if (!db || typeof db.ref !== 'function') {
      console.warn('[clone] RTDB not available for continuous mirroring');
      return;
    }

    const sourceRef: any = db.ref(DEFAULT_SOURCE);
    if (!sourceRef || typeof sourceRef.on !== 'function') {
      console.warn('[clone] RTDB ref does not support .on; skipping continuous mirroring');
      return;
    }

    const handler = async (snap: any) => {
      try {
        const data = snap?.val?.() ?? snap?.val ?? null;
        if (data === null || data === undefined) return;
        await appendHistorySnapshot(data);
        console.log('[clone] appended snapshot to GPS TRACKING HISTORY');
      } catch (err) {
        console.error('[clone] continuous mirror failed:', err);
      }
    };

    sourceRef.on('value', handler, (err: any) => {
      console.error('[clone] continuous mirror listener error:', err);
    });

    console.log('[clone] continuous mirroring enabled:', DEFAULT_SOURCE, '→', DEFAULT_TARGET);
  } catch (err) {
    console.warn('[clone] failed to start continuous mirroring:', err);
  }
}

function normalize(path: string | undefined, fallback: string) {
  if (!path || typeof path !== 'string') return fallback;
  const trimmed = path.trim();
  if (!trimmed) return fallback;
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

async function readPath(path: string) {
  const ref: any = (rtdb as any)?.ref ? (rtdb as any).ref(path) : null;
  if (!ref) throw new Error('rtdb unavailable');
  if (typeof ref.get === 'function') {
    const snap = await ref.get();
    return snap?.val?.() ?? snap?.val ?? null;
  }
  if (typeof ref.once === 'function') {
    const snap = await new Promise((resolve, reject) => ref.once('value', resolve, reject));
    return (snap as any)?.val?.() ?? (snap as any)?.val ?? null;
  }
  throw new Error('read not supported in RTDB shim');
}

async function writePath(path: string, data: any) {
  const ref: any = (rtdb as any)?.ref ? (rtdb as any).ref(path) : null;
  if (!ref) throw new Error('rtdb unavailable');
  if (typeof ref.set === 'function') {
    await ref.set(data);
    return;
  }
  if (typeof ref.update === 'function') {
    await ref.update(data);
    return;
  }
  throw new Error('write not supported in RTDB shim');
}

// Register the background listener as soon as this module is loaded.
startContinuousMirror();

router.post('/gps-tracking-history', async (req, res) => {
  try {
    if (!rtdb || typeof (rtdb as any).ref !== 'function') {
      return res.status(503).json({ status: 'error', message: 'RTDB not configured' });
    }

    const sourcePath = normalize((req.body as any)?.sourcePath ?? (req.query as any)?.sourcePath, DEFAULT_SOURCE);
    const targetPath = normalize((req.body as any)?.targetPath ?? (req.query as any)?.targetPath, DEFAULT_TARGET);

    const data = await readPath(sourcePath);
    if (data === null || data === undefined) {
      return res.status(404).json({ status: 'error', message: 'No data at source path', sourcePath });
    }

    await writePath(targetPath, data);

    res.json({
      status: 'success',
      message: 'GPS Tracking data copied to history path',
      sourcePath,
      targetPath,
    });
  } catch (error: any) {
    res.status(500).json({ status: 'error', message: error?.message || 'internal error' });
  }
});

export default router;
