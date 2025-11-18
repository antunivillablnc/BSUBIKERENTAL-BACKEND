import { Router } from 'express';
import { db, rtdb, historyRtdb } from '../lib/firebase.js';

const router = Router();

function toNumber(v: any): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function parseTimestamp(v: any): number {
  if (!v) return Date.now();
  if (typeof v === 'number') return v < 2_000_000_000 ? v * 1000 : v;
  const s = String(v);
  const n = Number(s);
  if (Number.isFinite(n)) return n < 2_000_000_000 ? n * 1000 : n;
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : Date.now();
}

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

async function writeRtdbBatch(target: any, updates: Record<string, any>) {
  if (!target || typeof target.ref !== 'function') return;
  const entries = Object.entries(updates);
  if (!entries.length) return;
  const rootRef = target.ref('/');
  if (rootRef && typeof rootRef.update === 'function') {
    try {
      await target.ref().update(updates);
      return;
    } catch {
      // fallthrough to per-path sets
    }
  }
  const ops = entries.map(([path, value]) => target.ref(path).set(value));
  await Promise.all(ops);
}

router.post('/', async (req, res) => {
  try {
    // Demo mode: no auth secret required. Accept typical SIM800L payloads.
    const qs: any = (req.query as any) || {};
    let body: any = (req.body as any) || {};
    if (typeof body === 'string') {
      try {
        const parsed = JSON.parse(body);
        body = parsed;
      } catch {
        // keep as string; handled below by merging with qs
      }
    }

    // Merge common sources (SIM800 often uses x-www-form-urlencoded or query)
    const src: any = { ...(qs || {}), ...(typeof body === 'object' && body ? body : {}) };

    // Resolve device identifier from common aliases
    const id = String(
      src.deviceId || src.device || src.id || src.imei || src.IMEI || req.headers['x-device-id'] || ''
    ).trim();

    // Resolve lat/lng from common aliases
    let lat =
      toNumber(src.latitude) ??
      toNumber(src.lat) ??
      toNumber(src.gpsLat) ??
      toNumber((src as any)?.Latitude) ??
      toNumber((src as any)?.Lat) ??
      toNumber((src as any)?.LAT);

    let lng =
      toNumber(src.longitude) ??
      toNumber(src.lng) ??
      toNumber(src.lon) ??
      toNumber(src.long) ??
      toNumber(src.gpsLng) ??
      toNumber((src as any)?.Longitude) ??
      toNumber((src as any)?.Lng) ??
      toNumber((src as any)?.LNG);

    // Fallback: parse from a single "coords" string like "lat,lng" or "lat lng"
    if ((lat === undefined || lng === undefined)) {
      const coordStr =
        (typeof src.coords === 'string' && src.coords) ||
        (typeof src.coordinate === 'string' && src.coordinate) ||
        (typeof src.location === 'string' && src.location) ||
        (typeof src.ll === 'string' && src.ll) ||
        (typeof src.gps === 'string' && src.gps) ||
        '';
      if (coordStr) {
        const raw = String(coordStr);
        const tokens = raw.split(/[,\s;]+/).filter(Boolean);
        const numeric: number[] = [];
        for (const t of tokens) {
          const match = t.match(/-?\d+(\.\d+)?/);
          if (!match) continue;
          const n = toNumber(match[0]);
          if (n !== undefined) numeric.push(n);
        }
        if (numeric.length >= 2) {
          if (lat === undefined) lat = numeric[0];
          if (lng === undefined) lng = numeric[1];
        }
      }
    }

    // Heuristic: if values look like NMEA ddmm.mmmm or dddmm.mmmm, convert to decimal degrees
    const limitLat = 90;
    const limitLng = 180;
    if (lat !== undefined && (Math.abs(lat) > limitLat)) {
      const converted = fromNmeaDdmm(lat, 'lat');
      if (converted !== undefined) lat = converted;
    }
    if (lng !== undefined && (Math.abs(lng) > limitLng)) {
      const converted = fromNmeaDdmm(lng, 'lng');
      if (converted !== undefined) lng = converted;
    }

    if (!id) return res.status(400).json({ status: 'error', message: 'deviceId required' });
    if (lat === undefined || lng === undefined) return res.status(400).json({ status: 'error', message: 'latitude,longitude required' });
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return res.status(422).json({ status: 'error', message: 'lat/lng out of range' });

    // Flexible timestamp fields
    const ts = parseTimestamp(
      src.timestamp ?? src.ts ?? src.time ?? src.epoch ?? src.date
    );
    const receivedAt = Date.now();

    // Attempt to resolve bike assigned to this deviceId via bikes.DEVICE_ID (fallback to bikes.deviceId)
    let bike: any = null;
    try {
      const snap1 = await db.collection('bikes').where('DEVICE_ID', '==', id).limit(1).get();
      if (!snap1.empty) {
        const d: any = snap1.docs[0];
        bike = { id: d.id, ...d.data() };
      } else {
        const snap2 = await db.collection('bikes').where('deviceId', '==', id).limit(1).get();
        if (!snap2.empty) {
          const d: any = snap2.docs[0];
          bike = { id: d.id, ...d.data() };
        }
      }
    } catch {
      // ignore lookup failures and proceed with device-only writes
    }

    const telemetry = {
      lat,
      lng,
      speed: (toNumber(src.speed) ?? toNumber(src.speedKmh) ?? toNumber(src.speed_kmh) ?? toNumber(src.kmh)) ?? null,
      heading: (toNumber(src.heading) ?? toNumber(src.bearing) ?? toNumber(src.course)) ?? null,
      accuracy: (toNumber(src.accuracy) ?? toNumber(src.acc) ?? toNumber(src.hAcc)) ?? null,
      alt: (toNumber(src.alt) ?? toNumber(src.altitude)) ?? null,
      battery: (toNumber(src.battery) ?? toNumber(src.batt) ?? toNumber(src.battery_level) ?? toNumber(src.batteryPercent)) ?? null,
      alertType: typeof src.alertType === 'string' ? src.alertType : '',
      signalStrength: (toNumber(src.signalStrength) ?? toNumber(src.rssi) ?? toNumber(src.signal)) ?? null,
      localIP: typeof src.localIP === 'string' ? src.localIP : null,
      imei: typeof src.imei === 'string' ? src.imei : (typeof src.IMEI === 'string' ? src.IMEI : null),
      ts,
      receivedAt,
    };

    const tsKey = String(ts);
    // Build RTDB multi-location updates
    const updates: Record<string, any> = {};
    const historyUpdates: Record<string, any> = {};

    // Device-scoped writes
    const deviceBase = `/tracker/devices/${id}`;
    updates[`${deviceBase}/telemetry/${tsKey}`] = telemetry;
    updates[`${deviceBase}/last`] = telemetry;

    // Feed entry, enriched with bike when available
    updates[`/tracker/feed/${tsKey}_${id}`] = {
      deviceId: id,
      bikeId: bike?.id ?? null,
      bikeName: bike?.name ?? null,
      ...telemetry,
    };

    // Bike-scoped writes (only if bike is resolved)
    if (bike?.id) {
      const bikeBase = `/tracker/bikes/${bike.id}`;
      const enriched = { ...telemetry, deviceId: id, bikeId: bike.id, bikeName: bike.name ?? null };
      updates[`${bikeBase}/telemetry/${tsKey}`] = enriched;
      updates[`${bikeBase}/last`] = enriched;

      // Optional: by-name convenience key
      const nameKey = String(bike.name || bike.id).replace(/[.#$\[\]/]/g, '_');
      updates[`/tracker/bikesByName/${nameKey}/last`] = enriched;
    }

    const historyPayload = {
      ...telemetry,
      deviceId: id,
      bikeId: bike?.id ?? null,
      bikeName: bike?.name ?? null,
    };
    historyUpdates[`/trackerHistory/feed/${tsKey}_${id}`] = historyPayload;
    historyUpdates[`/trackerHistory/devices/${id}/${tsKey}`] = historyPayload;
    if (bike?.id) {
      historyUpdates[`/trackerHistory/bikes/${bike.id}/${tsKey}`] = historyPayload;
    }

    await writeRtdbBatch(rtdb, updates);
    await writeRtdbBatch(historyRtdb, historyUpdates);

    return res.status(200).json({ status: 'success', message: 'Location data received', deviceId: id, bikeId: bike?.id ?? null });
  } catch (e: any) {
    return res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});

export default router;

// Debug/verification helper: read back the latest sample for a device
router.get('/last', async (req, res) => {
  try {
    const id = String((req.query as any).deviceId || '').trim();
    if (!id) return res.status(400).json({ status: 'error', message: 'deviceId required' });
    const path = `/tracker/devices/${id}/last`;
    const ref: any = (rtdb as any).ref ? (rtdb as any).ref(path) : null;
    if (!ref) return res.status(500).json({ status: 'error', message: 'rtdb unavailable' });
    let snap: any = null;
    if (typeof ref.get === 'function') {
      snap = await ref.get();
      return res.json({ status: 'success', deviceId: id, data: snap?.val?.() ?? snap?.val ?? null });
    }
    if (typeof ref.once === 'function') {
      snap = await new Promise((resolve, reject) => ref.once('value', resolve, reject));
      return res.json({ status: 'success', deviceId: id, data: snap?.val?.() ?? snap?.val ?? null });
    }
    return res.status(500).json({ status: 'error', message: 'read not supported in shim' });
  } catch (e: any) {
    return res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});

// Read back the latest sample for a bike
router.get('/last-by-bike', async (req, res) => {
  try {
    const bikeId = String((req.query as any).bikeId || '').trim();
    if (!bikeId) return res.status(400).json({ status: 'error', message: 'bikeId required' });
    const path = `/tracker/bikes/${bikeId}/last`;
    const ref: any = (rtdb as any).ref ? (rtdb as any).ref(path) : null;
    if (!ref) return res.status(500).json({ status: 'error', message: 'rtdb unavailable' });
    let snap: any = null;
    if (typeof ref.get === 'function') {
      snap = await ref.get();
      return res.json({ status: 'success', bikeId, data: snap?.val?.() ?? snap?.val ?? null });
    }
    if (typeof ref.once === 'function') {
      snap = await new Promise((resolve, reject) => ref.once('value', resolve, reject));
      return res.json({ status: 'success', bikeId, data: snap?.val?.() ?? snap?.val ?? null });
    }
    return res.status(500).json({ status: 'error', message: 'read not supported in shim' });
  } catch (e: any) {
    return res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});

// Resolve deviceId → bike metadata
router.get('/resolve', async (req, res) => {
  try {
    const id = String((req.query as any).deviceId || '').trim();
    if (!id) return res.status(400).json({ status: 'error', message: 'deviceId required' });
    let bike: any = null;
    try {
      const snap1 = await db.collection('bikes').where('DEVICE_ID', '==', id).limit(1).get();
      if (!snap1.empty) {
        const d: any = snap1.docs[0];
        bike = { id: d.id, ...d.data() };
      } else {
        const snap2 = await db.collection('bikes').where('deviceId', '==', id).limit(1).get();
        if (!snap2.empty) {
          const d: any = snap2.docs[0];
          bike = { id: d.id, ...d.data() };
        }
      }
    } catch {}
    if (!bike) return res.json({ status: 'success', found: false });
    return res.json({ status: 'success', found: true, bike: { id: bike.id, name: bike.name ?? null } });
  } catch (e: any) {
    return res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});

// Clone legacy GPS Tracking tree to the secondary RTDB cluster
router.post('/clone-gps-tracking', async (req, res) => {
  try {
    if (!historyRtdb) {
      return res.status(503).json({ status: 'error', message: 'history RTDB not configured' });
    }

    const normalizePath = (path?: string, fallback: string = '/GPS Tracking') => {
      if (!path || typeof path !== 'string' || !path.trim()) return fallback;
      const trimmed = path.trim();
      return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    };

    const sourcePath = normalizePath((req.body as any)?.sourcePath ?? (req.query as any)?.sourcePath);
    const targetPath = normalizePath((req.body as any)?.targetPath ?? (req.query as any)?.targetPath, sourcePath);

    const sourceRef: any = (rtdb as any).ref ? (rtdb as any).ref(sourcePath) : null;
    if (!sourceRef) return res.status(500).json({ status: 'error', message: 'source RTDB unavailable' });

    let snap: any = null;
    if (typeof sourceRef.get === 'function') {
      snap = await sourceRef.get();
    } else if (typeof sourceRef.once === 'function') {
      snap = await new Promise((resolve, reject) => sourceRef.once('value', resolve, reject));
    } else {
      return res.status(500).json({ status: 'error', message: 'read not supported in source RTDB' });
    }

    const data = snap?.val?.() ?? snap?.val ?? null;
    if (data === null || data === undefined) {
      return res.status(404).json({ status: 'error', message: 'no data found at source path', sourcePath });
    }

    const targetRef: any = (historyRtdb as any).ref ? (historyRtdb as any).ref(targetPath) : null;
    if (!targetRef) return res.status(500).json({ status: 'error', message: 'target RTDB unavailable' });

    if (typeof targetRef.set === 'function') {
      await targetRef.set(data);
    } else if (typeof targetRef.update === 'function') {
      await targetRef.update(data);
    } else {
      return res.status(500).json({ status: 'error', message: 'write not supported in target RTDB' });
    }

    return res.json({
      status: 'success',
      message: 'GPS tracking data cloned',
      sourcePath,
      targetPath,
    });
  } catch (e: any) {
    return res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});

// Simple diagnostics to confirm RTDB connectivity and env
router.get('/diag', async (_req, res) => {
  try {
    const root: any = (rtdb as any).ref ? (rtdb as any).ref('/') : null;
    const canUpdate = !!(root && typeof root.update === 'function');
    res.json({
      status: 'success',
      rtdbMode: canUpdate ? 'admin' : 'limited',
      env: {
        FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID ? 'set' : 'missing',
        FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL || '(unset)'
      },
    });
  } catch (e: any) {
    res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});


