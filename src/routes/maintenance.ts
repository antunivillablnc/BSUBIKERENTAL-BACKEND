import { Router } from 'express';
import { db } from '../lib/firebase.js';
import { requireRole } from '../middleware/auth.js';
import * as tf from '@tensorflow/tfjs';

type RideRow = {
  bike_name: string | null;
  ride_date: Date | null;
  distance_km: number | null;
  duration_min: number | null;
  avg_speed_kmh: number | null;
};

type IssueRow = { bikeId: string; reportedAt: Date };

const router = Router();

function daysBetween(a: Date, b: Date) {
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));
}

function isFiniteNum(n: any): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

async function fetchRides(): Promise<RideRow[]> {
  const since = new Date();
  since.setDate(since.getDate() - 365);

  const snap = await db.collection('analytical_data').where('ride_date', '>=', since).get();
  const rows: RideRow[] = snap.docs.map(d => {
    const r: any = d.data();
    const rd = r.ride_date?.toDate?.() || r.ride_date || null;
    return {
      bike_name: typeof r.bike_name === 'string' && r.bike_name.trim() ? r.bike_name.trim() : null,
      ride_date: rd instanceof Date ? rd : (typeof rd === 'string' ? new Date(rd) : null),
      distance_km: isFiniteNum(r.distance_km) ? r.distance_km : null,
      duration_min: isFiniteNum(r.duration_min) ? r.duration_min : null,
      avg_speed_kmh: isFiniteNum(r.avg_speed_kmh) ? r.avg_speed_kmh : null,
    };
  });
  return rows.filter(r => r.bike_name != null && r.ride_date instanceof Date);
}

async function fetchIssues(): Promise<IssueRow[]> {
  const snap = await db.collection('reported_issues').get();
  const items: IssueRow[] = snap.docs.map(d => {
    const it: any = d.data();
    const ra = it.reportedAt?.toDate?.() || it.reportedAt || null;
    return {
      bikeId: typeof it.bikeId === 'string' && it.bikeId ? it.bikeId : '',
      reportedAt: ra instanceof Date ? ra : (typeof ra === 'string' ? new Date(ra) : new Date(0)),
    };
  });
  return items.filter(i => i.bikeId);
}

function normalizeName(s: string) {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function mapBikeNameToFirestoreId(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const bikesSnap = await db.collection('bikes').get();
  bikesSnap.docs.forEach(d => {
    const b: any = d.data();
    const name = (b?.name ?? '').toString();
    const norm = normalizeName(name);
    if (norm) map.set(norm, d.id);
  });
  return map;
}

type Dataset = {
  X: number[][];
  y: number[];
  featureNames: string[];
};

function buildFeaturesForRide(
  ride: RideRow,
  trailing: { rides7: number; rides30: number; dist7: number; dist30: number; dur7: number; dur30: number },
  daysSinceLastIssue: number | null
) {
  return [
    1,
    ride.distance_km ?? 0,
    ride.duration_min ?? 0,
    ride.avg_speed_kmh ?? 0,
    trailing.rides7,
    trailing.rides30,
    trailing.dist7,
    trailing.dist30,
    trailing.dur7,
    trailing.dur30,
    daysSinceLastIssue ?? 0,
  ];
}

async function buildDataset(): Promise<{ dataset: Dataset; latestByBike: Map<string, number[]>; bikesUsed: Set<string> }> {
  const rides = await fetchRides();
  const issues = await fetchIssues();
  const nameToBikeId = await mapBikeNameToFirestoreId();

  const issuesByBike = new Map<string, Date[]>();
  for (const i of issues) {
    const arr = issuesByBike.get(i.bikeId) || [];
    arr.push(i.reportedAt);
    issuesByBike.set(i.bikeId, arr);
  }
  for (const [_, arr] of issuesByBike) arr.sort((a, b) => a.getTime() - b.getTime());

  const ridesByBike = new Map<string, RideRow[]>();
  for (const r of rides) {
    const bikeName = r.bike_name as string;
    const fbId = nameToBikeId.get(normalizeName(bikeName));
    if (!fbId) continue;
    const arr = ridesByBike.get(fbId) || [];
    arr.push(r);
    ridesByBike.set(fbId, arr);
  }

  const featureNames = [
    'bias',
    'distance_km',
    'duration_min',
    'avg_speed_kmh',
    'rides_last_7d',
    'rides_last_30d',
    'distance_last_7d',
    'distance_last_30d',
    'duration_last_7d',
    'duration_last_30d',
    'days_since_last_issue',
  ];

  const X: number[][] = [];
  const y: number[] = [];
  const latestByBike = new Map<string, number[]>();
  const bikesUsed = new Set<string>();

  for (const [bikeId, arr] of ridesByBike) {
    arr.sort((a, b) => (a.ride_date!.getTime() - b.ride_date!.getTime()));

    const window7: RideRow[] = [];
    const window30: RideRow[] = [];
    let lastIssue: Date | null = null;
    const bikeIssues = (issuesByBike.get(bikeId) || []).slice();
    let issueIdx = 0;

    // Build prefix sum of distances to quickly compute km between rides
    const prefixKm: number[] = new Array(arr.length).fill(0);
    for (let i = 0; i < arr.length; i++) {
      const d = Number(arr[i].distance_km || 0);
      prefixKm[i] = (i > 0 ? prefixKm[i - 1] : 0) + (Number.isFinite(d) ? d : 0);
    }

    for (let i = 0; i < arr.length; i++) {
      const r = arr[i];
      const currentDate = r.ride_date!;

      const cutoff7 = new Date(currentDate); cutoff7.setDate(cutoff7.getDate() - 7);
      const cutoff30 = new Date(currentDate); cutoff30.setDate(cutoff30.getDate() - 30);
      while (window7.length && (window7[0].ride_date! < cutoff7)) window7.shift();
      while (window30.length && (window30[0].ride_date! < cutoff30)) window30.shift();
      window7.push(r);
      window30.push(r);

      while (issueIdx < bikeIssues.length && bikeIssues[issueIdx] <= currentDate) {
        lastIssue = bikeIssues[issueIdx];
        issueIdx += 1;
      }

      const nextIssue = (issueIdx < bikeIssues.length) ? bikeIssues[issueIdx] : null;
      if (!nextIssue) {
        const trailing = {
          rides7: window7.length,
          rides30: window30.length,
          dist7: window7.reduce((s, v) => s + (v.distance_km || 0), 0),
          dist30: window30.reduce((s, v) => s + (v.distance_km || 0), 0),
          dur7: window7.reduce((s, v) => s + (v.duration_min || 0), 0),
          dur30: window30.reduce((s, v) => s + (v.duration_min || 0), 0),
        };
        const daysSince = lastIssue ? daysBetween(lastIssue, currentDate) : null;
        latestByBike.set(bikeId, buildFeaturesForRide(r, trailing, daysSince));
        continue;
      }

      const trailing = {
        rides7: window7.length,
        rides30: window30.length,
        dist7: window7.reduce((s, v) => s + (v.distance_km || 0), 0),
        dist30: window30.reduce((s, v) => s + (v.distance_km || 0), 0),
        dur7: window7.reduce((s, v) => s + (v.duration_min || 0), 0),
        dur30: window30.reduce((s, v) => s + (v.duration_min || 0), 0),
      };
      const daysSince = lastIssue ? daysBetween(lastIssue, currentDate) : null;
      const feats = buildFeaturesForRide(r, trailing, daysSince);
      // Label: kilometers until the next issue
      let labelKm = 0;
      if (nextIssue) {
        // find last ride index j where ride_date <= nextIssue
        let j = i;
        while (j + 1 < arr.length && (arr[j + 1].ride_date! <= nextIssue)) j++;
        const afterCurrentIdx = Math.min(arr.length - 1, Math.max(i + 1, 0));
        labelKm = j >= afterCurrentIdx ? prefixKm[j] - prefixKm[i] : 0;
      }

      if (feats.every(isFiniteNum) && isFiniteNum(labelKm)) {
        X.push(feats);
        y.push(labelKm);
        bikesUsed.add(bikeId);
      }
    }
  }

  return { dataset: { X, y, featureNames }, latestByBike, bikesUsed };
}

function mae(yTrue: number[], yPred: number[]) {
  const n = yTrue.length || 1;
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) s += Math.abs(yTrue[i] - yPred[i]);
  return s / n;
}
function mse(yTrue: number[], yPred: number[]) {
  const n = yTrue.length || 1;
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) { const e = yTrue[i] - yPred[i]; s += e * e; }
  return s / n;
}
function r2(yTrue: number[], yPred: number[]) {
  const mean = yTrue.reduce((s, v) => s + v, 0) / (yTrue.length || 1);
  let ssRes = 0, ssTot = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const e = yTrue[i] - yPred[i];
    ssRes += e * e;
    const d = yTrue[i] - mean;
    ssTot += d * d;
  }
  return 1 - (ssRes / (ssTot || 1));
}

async function trainLinear(X: number[][], y: number[]) {
  const xs = tf.tensor2d(X);
  const ys = tf.tensor2d(y, [y.length, 1]);

  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 1, inputShape: [X[0].length], useBias: false }));
  model.compile({ optimizer: tf.train.adam(0.05), loss: 'meanSquaredError' });

  const epochs = 200;
  await model.fit(xs, ys, { epochs, verbose: 0 });

  const preds = (model.predict(xs) as tf.Tensor).arraySync() as number[][];
  const yPred = preds.map(r => r[0]);

  const metrics = { mae: mae(y, yPred), mse: mse(y, yPred), r2: r2(y, yPred) };

  const weights = (model.getWeights()[0].arraySync() as number[][]).map(row => row[0]);
  xs.dispose(); ys.dispose();
  return { model, weights, metrics };
}

router.post('/train', requireRole('admin', 'teaching_staff'), async (_req, res) => {
  try {
    const { dataset, latestByBike, bikesUsed } = await buildDataset();
    if (dataset.X.length < 10) return res.status(400).json({ success: false, error: 'Not enough labeled data to train' });

    const { model, weights, metrics } = await trainLinear(dataset.X, dataset.y);

    const modelDoc = await db.collection('maintenance_models').add({
      createdAt: new Date(),
      featureNames: dataset.featureNames,
      weights,
      metrics,
      n: dataset.y.length,
    });

    const preds: any[] = [];
    // Predict for ALL bikes we have latest features for (not only those with issues)
    for (const [bikeId, feats] of latestByBike.entries()) {
      if (!Array.isArray(feats) || feats.length !== weights.length) continue;
      const yhatKm = weights.reduce((s, w, i) => s + w * feats[i], 0);
      preds.push({
        bikeId,
        predictedKmUntilMaintenance: Math.max(0, Number.isFinite(yhatKm) ? Number(Number(yhatKm).toFixed(2)) : 0),
        updatedAt: new Date().toISOString(),
      });
    }

    const batch = db.batch();
    preds.forEach(p => {
      const ref = db.collection('maintenance_predictions').doc(p.bikeId);
      batch.set(ref, p, { merge: true });
    });
    await batch.commit();

    preds.sort((a, b) => (a.predictedKmUntilMaintenance ?? 1e12) - (b.predictedKmUntilMaintenance ?? 1e12));
    res.json({ success: true, modelId: modelDoc.id, metrics, top: preds.slice(0, 20) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to train model' });
  }
});

router.get('/predictions', requireRole('admin', 'teaching_staff'), async (_req, res) => {
  try {
    const predsSnap = await db.collection('maintenance_predictions').get();
    const preds = predsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

    const latestModelSnap = await db.collection('maintenance_models').orderBy('createdAt', 'desc').limit(1).get();
    const model = latestModelSnap.empty ? null : { id: latestModelSnap.docs[0].id, ...latestModelSnap.docs[0].data() };

    preds.sort((a: any, b: any) => (a.predictedKmUntilMaintenance ?? 1e12) - (b.predictedKmUntilMaintenance ?? 1e12));
    res.json({ success: true, predictions: preds, model });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load predictions' });
  }
});

export default router;
