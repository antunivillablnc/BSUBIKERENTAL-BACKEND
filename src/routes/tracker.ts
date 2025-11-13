import { Router } from 'express';
import { db, rtdb } from '../lib/firebase.js';

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

router.post('/', async (req, res) => {
  try {
		const secret = process.env.IOT_SHARED_SECRET || '';
		const allowUnauthEnv = String(process.env.TRACKER_ALLOW_UNAUTH || '').trim().toLowerCase();
		const allowUnauth = allowUnauthEnv === 'true' || allowUnauthEnv === '1' || allowUnauthEnv === 'yes';

		// When temporarily allowing unauthenticated tracker posts, skip secret checks entirely
		if (!allowUnauth && !secret) {
			return res.status(500).json({ status: 'error', message: 'server-misconfig' });
		}

    // Accept multiple auth styles: Authorization: Bearer, X-Api-Key, or secret in body/query
    const authHeader = String(req.headers['authorization'] || '').trim();
    const apiKeyHeader = String(req.headers['x-api-key'] || '').trim();
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
		const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
		if (!allowUnauth) {
			const candidateKeys = [
				bearerToken,
				apiKeyHeader,
				String(body?.secret || body?.apiKey || body?.key || ''),
				String(qs?.secret || qs?.apiKey || qs?.key || ''),
			].filter(Boolean);
			if (!candidateKeys.some(k => k === secret)) {
				return res.status(401).json({ status: 'error', message: 'unauthorized' });
			}
		}

    // Merge common sources (SIM800 often uses x-www-form-urlencoded or query)
    const src: any = { ...(qs || {}), ...(typeof body === 'object' && body ? body : {}) };

    // Resolve device identifier from common aliases
    const id = String(
      src.deviceId || src.device || src.id || src.imei || src.IMEI || req.headers['x-device-id'] || ''
    ).trim();

    // Resolve lat/lng from common aliases
    const lat =
      toNumber(src.latitude) ??
      toNumber(src.lat) ??
      toNumber(src.gpsLat);

    const lng =
      toNumber(src.longitude) ??
      toNumber(src.lng) ??
      toNumber(src.lon) ??
      toNumber(src.long) ??
      toNumber(src.gpsLng);

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
    const updates: Record<string, any> = {};

    // Device-scoped writes (existing)
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

    // Support both real RTDB (admin SDK) and the Mongo fallback shim (which only implements .set)
    try {
      const rootRef: any = (rtdb as any).ref ? (rtdb as any).ref('/') : null;
      if (rootRef && typeof rootRef.update === 'function') {
        await (rtdb as any).ref().update(updates);
      } else {
        const ops = Object.entries(updates).map(([p, v]) => (rtdb as any).ref(p).set(v));
        await Promise.all(ops);
      }
    } catch {
      // Fallback: attempt per-path set if bulk update fails
      const ops = Object.entries(updates).map(([p, v]) => (rtdb as any).ref(p).set(v));
      await Promise.all(ops);
    }

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
        FIREBASE_DATABASE_URL: process.env.FIREBASE_DATABASE_URL || '(unset)',
        IOT_SHARED_SECRET: (process.env.IOT_SHARED_SECRET || '').length ? 'set' : 'missing',
      },
    });
  } catch (e: any) {
    res.status(500).json({ status: 'error', message: e?.message || 'internal error' });
  }
});


