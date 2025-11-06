import { Router } from 'express';
import { db, rtdb } from '../lib/firebase.js';
import { requireRole } from '../middleware/auth.js';
import * as tf from '@tensorflow/tfjs';
import { spawn } from 'node:child_process';
import path from 'node:path';

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
  const rows: RideRow[] = snap.docs.map((d: any) => {
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
  const items: IssueRow[] = snap.docs.map((d: any) => {
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
  bikesSnap.docs.forEach((d: any) => {
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
  daysSinceLastIssue: number | null,
  kmSinceLastIssue: number
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
    kmSinceLastIssue,
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
    'km_since_last_issue',
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
    let kmSinceIssue = 0;

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
        kmSinceIssue = 0; // reset on crossing an issue date
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
        latestByBike.set(bikeId, buildFeaturesForRide(r, trailing, daysSince, kmSinceIssue));
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
      const feats = buildFeaturesForRide(r, trailing, daysSince, kmSinceIssue);
      // Label: kilometers until the next issue
      let labelKm = 0;
      if (nextIssue) {
        // find last ride index j where ride_date <= nextIssue
        let j = i;
        while (j + 1 < arr.length && (arr[j + 1].ride_date! <= nextIssue)) j++;
        const afterCurrentIdx = Math.min(arr.length - 1, Math.max(i + 1, 0));
        labelKm = j >= afterCurrentIdx ? prefixKm[j] - prefixKm[i] : 0;
      }

      if (feats.every(isFiniteNum) && isFiniteNum(labelKm) && labelKm > 0.01) {
        X.push(feats);
        y.push(labelKm);
        bikesUsed.add(bikeId);
      }

      // advance km since last issue after using current ride as features
      kmSinceIssue += Number(r.distance_km || 0);
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

function rmse(yTrue: number[], yPred: number[]) {
  return Math.sqrt(mse(yTrue, yPred));
}

type TargetTransform = 'none' | 'log1p';
const TARGET_CAP_KM = 500; // cap extreme labels to stabilize loss

function applyInverseTransform(value: number, t: TargetTransform) {
  if (t === 'log1p') return Math.max(0, Math.expm1(value));
  return value;
}

async function trainLinear(X: number[][], y: number[], transform: TargetTransform = 'log1p') {
  const xs = tf.tensor2d(X);
  const yCapped = y.map(v => Math.min(TARGET_CAP_KM, Math.max(0, v)));
  const yTrain = transform === 'log1p' ? yCapped.map(v => Math.log1p(v)) : yCapped;
  const ys = tf.tensor2d(yTrain, [yTrain.length, 1]);

  const model = tf.sequential();
  model.add(tf.layers.dense({ units: 1, inputShape: [X[0].length], useBias: false, kernelRegularizer: tf.regularizers.l2({ l2: 1e-4 }) }));
  model.compile({ optimizer: tf.train.adam(0.01), loss: 'meanSquaredError' });

  const epochs = 150;
  await model.fit(xs, ys, { epochs, verbose: 0 });

  const preds = (model.predict(xs) as tf.Tensor).arraySync() as number[][];
  const yPredRaw = preds.map(r => r[0]);
  // Clamp predictions to the training range to avoid extreme expm1 blowups
  const minRaw = Math.min(...yTrain);
  const maxRaw = Math.max(...yTrain);
  const yPred = yPredRaw.map(v => applyInverseTransform(Math.max(minRaw, Math.min(maxRaw, v)), transform));

  const metrics = { mae: mae(y, yPred), mse: mse(y, yPred), rmse: rmse(y, yPred), r2: r2(y, yPred) } as const;

  const weights = (model.getWeights()[0].arraySync() as number[][]).map(row => row[0]);
  xs.dispose(); ys.dispose();
  return { model, weights, metrics, transform };
}

// Attempt to train using XGBoost WASM; return null if unavailable or on error
async function trainXGBoost(
  Xtrain: number[][],
  ytrain: number[],
  Xval: number[][],
  yval: number[],
  featureNames: string[]
): Promise<
  | {
      boosterBytesB64: string;
      params: Record<string, any>;
      bestIteration: number | null;
      yhatTrain: number[];
      yhatVal: number[];
    }
  | null
> {
  try {
    // Dynamic import to avoid hard dependency if not installed
    // @ts-ignore - optional dependency resolved at runtime if present
    const xgb: any = await import('xgboost');

    // Flatten helpers
    const ncol = Xtrain[0]?.length || 0;
    const toFloat32 = (M: number[][]) => new Float32Array(M.flatMap(r => r.map(v => Number.isFinite(v) ? v : 0)));
    const dtrain = new xgb.DMatrix({ data: toFloat32(Xtrain), ncols: ncol, nrows: Xtrain.length, label: new Float32Array(ytrain) });
    const dval = new xgb.DMatrix({ data: toFloat32(Xval), ncols: ncol, nrows: Xval.length, label: new Float32Array(yval) });

    const params = {
      objective: 'reg:squarederror',
      max_depth: 6,
      eta: 0.1,
      subsample: 0.8,
      colsample_bytree: 0.8,
      eval_metric: ['rmse', 'mae'],
    } as any;

    const booster = await xgb.train({
      params,
      dtrain,
      num_boost_round: 200,
      evals: [{ dtrain, name: 'train' }, { dtrain: dval, name: 'val' }],
      early_stopping_rounds: 20,
    });

    const yhatTrain = Array.from(await booster.predict(dtrain) as Float32Array).map(v => Number(v));
    const yhatVal = Array.from(await booster.predict(dval) as Float32Array).map(v => Number(v));

    // Persist raw booster bytes (base64) for inference later
    const raw: Uint8Array = await booster.saveRaw();
    const boosterBytesB64 = Buffer.from(raw).toString('base64');
    const bestIteration = Number.isFinite(booster?.best_iteration) ? Number(booster.best_iteration) : null;

    return { boosterBytesB64, params, bestIteration, yhatTrain, yhatVal };
  } catch (e) {
    // Silently fall back to linear when XGBoost is not available
    return null;
  }
}

router.post('/train', requireRole('admin', 'teaching_staff'), async (_req, res) => {
  try {
    const { dataset, latestByBike, bikesUsed } = await buildDataset();
    if (dataset.X.length < 10) return res.status(400).json({ success: false, error: 'Not enough labeled data to train' });

    // Split train/val (80/20)
    const n = dataset.X.length;
    const indices = Array.from({ length: n }, (_, i) => i);
    indices.sort(() => Math.random() - 0.5);
    const split = Math.max(1, Math.floor(n * 0.8));
    const trainIdx = indices.slice(0, split);
    const valIdx = indices.slice(split);

    const Xtrain = trainIdx.map(i => dataset.X[i]);
    const ytrain = trainIdx.map(i => dataset.y[i]);
    const Xval = valIdx.map(i => dataset.X[i]);
    const yval = valIdx.map(i => dataset.y[i]);

    // Standardize features using TRAIN stats only (exclude bias at index 0)
    const dims = dataset.featureNames.length;
    const means = new Array(dims).fill(0);
    const stds = new Array(dims).fill(1);
    for (let j = 1; j < dims; j++) {
      let s = 0;
      for (let i = 0; i < Xtrain.length; i++) s += Xtrain[i][j];
      means[j] = s / Xtrain.length;
    }
    for (let j = 1; j < dims; j++) {
      let s = 0;
      for (let i = 0; i < Xtrain.length; i++) { const d = Xtrain[i][j] - means[j]; s += d * d; }
      stds[j] = Math.sqrt(s / Math.max(1, Xtrain.length - 1)) || 1;
      if (!Number.isFinite(stds[j]) || stds[j] === 0) stds[j] = 1;
    }
    const toStd = (row: number[]) => {
      const out = [...row];
      for (let j = 1; j < dims; j++) out[j] = (out[j] - means[j]) / stds[j];
      return out;
    };
    const XtrainStd = Xtrain.map(toStd);
    const XvalStd = Xval.map(toStd);

    const wantXgb = (process.env.MODEL_ENGINE || 'xgb').toLowerCase() === 'xgb';
    let engineUsed: 'xgb' | 'linear' = 'linear';
    let weights: number[] = [];
    let transform: TargetTransform = 'log1p';
    let metrics: any;
    let boosterB64: string | null = null;
    let xgbPredictTrain: number[] | null = null;
    let xgbPredictVal: number[] | null = null;

    if (wantXgb) {
      const trained = await trainXGBoost(XtrainStd, ytrain, XvalStd, yval, dataset.featureNames);
      if (trained) {
        engineUsed = 'xgb';
        boosterB64 = trained.boosterBytesB64;
        xgbPredictTrain = trained.yhatTrain;
        xgbPredictVal = trained.yhatVal;
        metrics = { mae: mae(ytrain, xgbPredictTrain), rmse: rmse(ytrain, xgbPredictTrain), r2: r2(ytrain, xgbPredictTrain) };
      }
    }

    // Fallback to linear if XGBoost unavailable
    if (engineUsed === 'linear') {
      const linear = await trainLinear(XtrainStd, ytrain);
      weights = linear.weights;
      transform = linear.transform;
      metrics = linear.metrics;
    }

    // Evaluate on train and val
    function predictY(Xstd: number[][]) {
      return Xstd.map(row => weights.reduce((s, w, i) => s + w * row[i], 0));
    }
    let yhatTrain: number[] = [];
    let yhatVal: number[] = [];
    if (engineUsed === 'xgb' && xgbPredictTrain && xgbPredictVal) {
      yhatTrain = xgbPredictTrain.map(v => Math.max(0, Math.min(TARGET_CAP_KM, v)));
      yhatVal = xgbPredictVal.map(v => Math.max(0, Math.min(TARGET_CAP_KM, v)));
    } else {
      function predictY(Xstd: number[][]) {
        return Xstd.map(row => weights.reduce((s, w, i) => s + w * row[i], 0));
      }
      const yhatTrainRaw = predictY(XtrainStd);
      const yhatValRaw = predictY(XvalStd);
      yhatTrain = yhatTrainRaw.map(v => applyInverseTransform(v, transform));
      yhatVal = yhatValRaw.map(v => applyInverseTransform(v, transform));
    }
    const metricsTrain = { mae: mae(ytrain, yhatTrain), mse: mse(ytrain, yhatTrain), rmse: rmse(ytrain, yhatTrain), r2: r2(ytrain, yhatTrain) };
    const metricsVal = { mae: mae(yval, yhatVal), mse: mse(yval, yhatVal), rmse: rmse(yval, yhatVal), r2: r2(yval, yhatVal) };

    const modelDoc = await db.collection('maintenance_models').add({
      createdAt: new Date(),
      featureNames: dataset.featureNames,
      // Store linear weights for fallback; store booster for xgb
      weights: engineUsed === 'linear' ? weights : null,
      boosterB64: engineUsed === 'xgb' ? boosterB64 : null,
      metrics: { ...metrics, val: metricsVal, train: metricsTrain, engine: engineUsed },
      n: dataset.y.length,
      targetTransform: transform,
      featureMeans: means,
      featureStds: stds,
    });

    const preds: any[] = [];
    // Predict for ALL bikes we have latest features for (not only those with issues)
    for (const [bikeId, feats] of latestByBike.entries()) {
      if (!Array.isArray(feats)) continue;
      const featsStd = feats.slice();
      for (let j = 1; j < featsStd.length; j++) featsStd[j] = (featsStd[j] - means[j]) / stds[j];

      let yhatKm = 0;
      if (engineUsed === 'xgb' && boosterB64) {
        try {
          // @ts-ignore - optional dependency resolved at runtime if present
          const xgb: any = await import('xgboost');
          const booster = await xgb.Booster.loadModel(Buffer.from(boosterB64, 'base64'));
          const drow = new xgb.DMatrix({ data: new Float32Array(featsStd), ncols: featsStd.length, nrows: 1 });
          const predArr = Array.from(await booster.predict(drow) as Float32Array);
          yhatKm = Math.max(0, Math.min(TARGET_CAP_KM, predArr[0] || 0));
        } catch {
          const raw = weights.reduce((s, w, i) => s + w * featsStd[i], 0);
          yhatKm = Math.max(0, Math.min(TARGET_CAP_KM, applyInverseTransform(raw, transform)));
        }
      } else {
        const raw = weights.reduce((s, w, i) => s + w * featsStd[i], 0);
        yhatKm = Math.max(0, Math.min(TARGET_CAP_KM, applyInverseTransform(raw, transform)));
      }
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

    // Publish to Realtime Database for live updates (best-effort)
    try {
      const predsObject: Record<string, any> = {};
      preds.forEach(p => { predsObject[p.bikeId] = p; });
      await rtdb.ref('maintenance/predictions').set(predsObject);
      await rtdb.ref('maintenance/model').set({ id: modelDoc.id, metrics, n: dataset.y.length, createdAt: new Date().toISOString() });
    } catch {}

    preds.sort((a, b) => (a.predictedKmUntilMaintenance ?? 1e12) - (b.predictedKmUntilMaintenance ?? 1e12));
    res.json({ success: true, modelId: modelDoc.id, metrics, top: preds.slice(0, 20) });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to train model' });
  }
});

router.get('/predictions', requireRole('admin', 'teaching_staff'), async (_req, res) => {
  try {
    const predsSnap = await db.collection('maintenance_predictions').get();
    const preds = predsSnap.docs.map((d: any) => ({ id: d.id, ...d.data() }));

    const latestModelSnap = await db.collection('maintenance_models').orderBy('createdAt', 'desc').limit(1).get();
    const model = latestModelSnap.empty ? null : { id: latestModelSnap.docs[0].id, ...latestModelSnap.docs[0].data() };

    preds.sort((a: any, b: any) => (a.predictedKmUntilMaintenance ?? 1e12) - (b.predictedKmUntilMaintenance ?? 1e12));
    res.json({ success: true, predictions: preds, model });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to load predictions' });
  }
});

// Weekly hybrid forecast: uses historical issues counts and augments forecast by simulated XGBoost at-risk bikes
router.get('/forecast', requireRole('admin', 'teaching_staff'), async (_req, res) => {
  try {
    // 1) Build weekly history from reported_issues (past 52 weeks)
    const issuesSnap = await db.collection('reported_issues').get();
    const counts = new Map<string, number>();
    const weeksBack = 52;
    function weekStart(d: Date) {
      const dt = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      const day = dt.getUTCDay();
      const diff = (day + 6) % 7; // Monday=0
      dt.setUTCDate(dt.getUTCDate() - diff);
      return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
    }
    const today = new Date();
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - weeksBack * 7);
    for (const d of issuesSnap.docs) {
      const it: any = d.data();
      const ra = it.reportedAt?.toDate?.() || it.reportedAt || null;
      const date = ra instanceof Date ? ra : (typeof ra === 'string' ? new Date(ra) : null);
      if (!date || date < start) continue;
      const wk = weekStart(date).toISOString().slice(0, 10);
      counts.set(wk, (counts.get(wk) || 0) + 1);
    }
    // Fill gaps with zeros
    const weeks: string[] = [];
    const cur = weekStart(start);
    for (let i = 0; i <= weeksBack; i++) {
      const wk = new Date(cur); wk.setUTCDate(cur.getUTCDate() + i * 7);
      weeks.push(wk.toISOString().slice(0, 10));
    }
    const series = weeks.map(ds => ({ ds, y: counts.get(ds) || 0 }));

    // 2) Simulate at-risk future counts using maintenance_predictions and recent rides
    // Estimate weekly_km per bike from last 30 days analytical_data
    const since30 = new Date(); since30.setUTCDate(since30.getUTCDate() - 30);
    const ridesSnap = await db.collection('analytical_data').where('ride_date', '>=', since30).get();
    const dist30ByBike = new Map<string, number>();
    const nameToId = await mapBikeNameToFirestoreId();
    ridesSnap.docs.forEach((doc: any) => {
      const r: any = doc.data();
      const bikeName = (r?.bike_name ?? '').toString();
      const id = nameToId.get(normalizeName(bikeName));
      if (!id) return;
      const dist = Number(r?.distance_km || 0);
      if (!Number.isFinite(dist)) return;
      dist30ByBike.set(id, (dist30ByBike.get(id) || 0) + dist);
    });
    const weeklyKmByBike = new Map<string, number>();
    for (const [id, dist30] of dist30ByBike.entries()) {
      weeklyKmByBike.set(id, Math.max(1, dist30 / 4));
    }
    const defaultWeeklyKm = 20; // fallback

    const predsSnap = await db.collection('maintenance_predictions').get();
    const futureExpected = new Map<string, number>();
    predsSnap.docs.forEach((d: any) => {
      const p: any = d.data();
      const km = Number(p?.predictedKmUntilMaintenance || 0);
      if (!(km > 0)) return;
      const wkKm = weeklyKmByBike.get(d.id) || defaultWeeklyKm;
      if (!(wkKm > 0)) return;
      const weeksTo = Math.floor(km / wkKm);
      const wk = weekStart(new Date()).toISOString().slice(0, 10);
      const idx = Math.max(0, weeksTo);
      const futureWeek = new Date(weekStart(new Date())); futureWeek.setUTCDate(futureWeek.getUTCDate() + idx * 7);
      const key = futureWeek.toISOString().slice(0, 10);
      futureExpected.set(key, (futureExpected.get(key) || 0) + 1);
    });

    // 3) Call Prophet to forecast on weekly series
    const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'ml', 'prophet_forecast.py');
    const horizonWeeks = 12;
    const py = spawn(process.env.PYTHON_PATH || 'python', [script]);
    const input = JSON.stringify({ series, horizonWeeks });
    let out = ''; let err = '';
    py.stdout.on('data', (d) => out += d.toString());
    py.stderr.on('data', (d) => err += d.toString());
    py.stdin.write(input); py.stdin.end();
    await new Promise<void>(resolve => py.on('close', () => resolve()));
    let forecast: any = { forecast: [], nextMonth: { sumMean: 0, sumLower: 0, sumUpper: 0 } };
    try { forecast = JSON.parse(out || '{}'); } catch {}

    // 4) Hybrid: add simulated at-risk counts to Prophet forecast per week
    const hybrid = (forecast?.forecast || []).map((pt: any) => {
      const sim = Number(futureExpected.get(pt.ds) || 0);
      return {
        weekStart: pt.ds,
        yhat: Number(pt.yhat),
        yhat_lower: Number(pt.yhat_lower),
        yhat_upper: Number(pt.yhat_upper),
        atRiskSim: sim,
        yhat_plus_sim: Number(pt.yhat) + sim,
      };
    });

    // Aggregate next-month hybrid sum (use yhat_plus_sim)
    const nm = forecast?.nextMonth || {};
    let sumPlusSim = 0;
    const nmStart = nm.start; const nmEnd = nm.end;
    hybrid.forEach((h: any) => {
      if (h.weekStart >= nmStart && h.weekStart < nmEnd) sumPlusSim += h.yhat_plus_sim;
    });

    res.json({ success: true, granularity: 'W-MON', forecast: hybrid, nextMonth: { ...nm, sumPlusSim } });
  } catch (e: any) {
    res.status(500).json({ success: false, error: e?.message || 'Failed to generate forecast' });
  }
});

export default router;
